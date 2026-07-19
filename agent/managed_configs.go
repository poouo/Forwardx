package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type managedConfigSpec struct {
	Path            string `json:"path"`
	ContentBase64   string `json:"contentBase64"`
	Format          string `json:"format,omitempty"`
	Mode            uint32 `json:"mode,omitempty"`
	ValidateCommand string `json:"validateCommand,omitempty"`
	ServiceName     string `json:"serviceName,omitempty"`
}

type managedConfigBackup struct {
	spec         managedConfigSpec
	previous     []byte
	hadPrevious  bool
	previousMode os.FileMode
}

type managedConfigTransaction struct {
	backups []managedConfigBackup
}

func validateManagedConfigSpec(spec managedConfigSpec, data []byte, stagedPath string) error {
	if len(data) == 0 {
		return fmt.Errorf("%s is empty", spec.Path)
	}
	switch strings.ToLower(strings.TrimSpace(spec.Format)) {
	case "", "text":
	case "json":
		var decoded any
		if err := json.Unmarshal(data, &decoded); err != nil {
			return fmt.Errorf("%s contains invalid JSON: %w", spec.Path, err)
		}
	default:
		return fmt.Errorf("%s uses unsupported format %q", spec.Path, spec.Format)
	}
	if command := strings.TrimSpace(spec.ValidateCommand); command != "" {
		command = strings.ReplaceAll(command, "{{path}}", shellQuote(stagedPath))
		if !runShell(command) {
			return fmt.Errorf("%s validation command failed", spec.Path)
		}
	}
	return nil
}

func managedConfigFileMode(spec managedConfigSpec) (os.FileMode, error) {
	if spec.Mode == 0 {
		return 0644, nil
	}
	if spec.Mode > 0777 {
		return 0, fmt.Errorf("%s uses invalid file mode %#o", spec.Path, spec.Mode)
	}
	return os.FileMode(spec.Mode), nil
}

func applyManagedConfigs(specs []managedConfigSpec) (*managedConfigTransaction, error) {
	tx := &managedConfigTransaction{backups: make([]managedConfigBackup, 0, len(specs))}
	for _, raw := range specs {
		spec := raw
		spec.Path = filepath.Clean(strings.TrimSpace(spec.Path))
		if spec.Path == "." || !filepath.IsAbs(spec.Path) {
			tx.rollback()
			return nil, fmt.Errorf("managed config path must be absolute: %q", raw.Path)
		}
		mode, err := managedConfigFileMode(spec)
		if err != nil {
			tx.rollback()
			return nil, err
		}
		data, err := base64.StdEncoding.DecodeString(spec.ContentBase64)
		if err != nil {
			tx.rollback()
			return nil, fmt.Errorf("decode %s: %w", spec.Path, err)
		}
		if err := os.MkdirAll(filepath.Dir(spec.Path), 0755); err != nil {
			tx.rollback()
			return nil, err
		}
		staged, err := os.CreateTemp(filepath.Dir(spec.Path), ".forwardx-config-*")
		if err != nil {
			tx.rollback()
			return nil, err
		}
		stagedPath := staged.Name()
		cleanup := func() { _ = os.Remove(stagedPath) }
		if _, err = staged.Write(data); err == nil {
			err = staged.Chmod(mode)
		}
		if closeErr := staged.Close(); err == nil {
			err = closeErr
		}
		if err == nil {
			err = validateManagedConfigSpec(spec, data, stagedPath)
		}
		if err != nil {
			cleanup()
			tx.rollback()
			return nil, err
		}
		previous, readErr := os.ReadFile(spec.Path)
		hadPrevious := readErr == nil
		previousMode := mode
		if readErr != nil && !os.IsNotExist(readErr) {
			cleanup()
			tx.rollback()
			return nil, readErr
		}
		if hadPrevious {
			info, statErr := os.Stat(spec.Path)
			if statErr != nil {
				cleanup()
				tx.rollback()
				return nil, statErr
			}
			previousMode = info.Mode().Perm()
			if err := writeManagedConfigAtomic(spec.Path+".forwardx-last-good", previous, previousMode); err != nil {
				cleanup()
				tx.rollback()
				return nil, err
			}
		}
		tx.backups = append(tx.backups, managedConfigBackup{spec: spec, previous: previous, hadPrevious: hadPrevious, previousMode: previousMode})
		if err := os.Rename(stagedPath, spec.Path); err != nil {
			cleanup()
			tx.rollback()
			return nil, err
		}
	}
	return tx, nil
}

func writeManagedConfigAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".forwardx-restore-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Chmod(mode.Perm())
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func (tx *managedConfigTransaction) rollback() bool {
	if tx == nil {
		return true
	}
	ok := true
	services := map[string]bool{}
	for index := len(tx.backups) - 1; index >= 0; index-- {
		backup := tx.backups[index]
		var err error
		if backup.hadPrevious {
			err = writeManagedConfigAtomic(backup.spec.Path, backup.previous, backup.previousMode)
		} else {
			err = os.Remove(backup.spec.Path)
			if os.IsNotExist(err) {
				err = nil
			}
		}
		if err != nil {
			ok = false
			logf("managed config restore failed path=%s error=%v", backup.spec.Path, err)
		}
		if backup.hadPrevious && strings.TrimSpace(backup.spec.ServiceName) != "" {
			services[strings.TrimSpace(backup.spec.ServiceName)] = true
		}
	}
	for service := range services {
		restartManagedService(service)
	}
	return ok
}
