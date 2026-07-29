package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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
	generation   uint64
}

type managedConfigTransaction struct {
	backups    []managedConfigBackup
	stateMu    sync.Mutex
	finished   bool
	rollbackOK bool
}

var managedConfigMutationMu sync.Mutex
var managedConfigGeneration atomic.Uint64
var managedConfigCurrentGeneration = map[string]uint64{}

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
	managedConfigMutationMu.Lock()
	defer managedConfigMutationMu.Unlock()

	tx := &managedConfigTransaction{backups: make([]managedConfigBackup, 0, len(specs))}
	generation := managedConfigGeneration.Add(1)
	for _, raw := range specs {
		spec := raw
		spec.Path = filepath.Clean(strings.TrimSpace(spec.Path))
		if spec.Path == "." || !filepath.IsAbs(spec.Path) {
			tx.rollbackLocked()
			return nil, fmt.Errorf("managed config path must be absolute: %q", raw.Path)
		}
		mode, err := managedConfigFileMode(spec)
		if err != nil {
			tx.rollbackLocked()
			return nil, err
		}
		data, err := base64.StdEncoding.DecodeString(spec.ContentBase64)
		if err != nil {
			tx.rollbackLocked()
			return nil, fmt.Errorf("decode %s: %w", spec.Path, err)
		}
		if err := os.MkdirAll(filepath.Dir(spec.Path), 0755); err != nil {
			tx.rollbackLocked()
			return nil, err
		}
		staged, err := os.CreateTemp(filepath.Dir(spec.Path), ".forwardx-config-*")
		if err != nil {
			tx.rollbackLocked()
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
			tx.rollbackLocked()
			return nil, err
		}
		previous, readErr := os.ReadFile(spec.Path)
		hadPrevious := readErr == nil
		previousMode := mode
		if readErr != nil && !os.IsNotExist(readErr) {
			cleanup()
			tx.rollbackLocked()
			return nil, readErr
		}
		if hadPrevious {
			info, statErr := os.Stat(spec.Path)
			if statErr != nil {
				cleanup()
				tx.rollbackLocked()
				return nil, statErr
			}
			previousMode = info.Mode().Perm()
			if err := writeManagedConfigAtomic(spec.Path+".forwardx-last-good", previous, previousMode); err != nil {
				cleanup()
				tx.rollbackLocked()
				return nil, err
			}
		}
		tx.backups = append(tx.backups, managedConfigBackup{spec: spec, previous: previous, hadPrevious: hadPrevious, previousMode: previousMode, generation: generation})
		if err := os.Rename(stagedPath, spec.Path); err != nil {
			cleanup()
			tx.rollbackLocked()
			return nil, err
		}
		managedConfigCurrentGeneration[spec.Path] = generation
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
	managedConfigMutationMu.Lock()
	defer managedConfigMutationMu.Unlock()
	return tx.rollbackLocked()
}

func (tx *managedConfigTransaction) rollbackLocked() bool {
	if tx == nil {
		return true
	}
	tx.stateMu.Lock()
	defer tx.stateMu.Unlock()
	if tx.finished {
		return tx.rollbackOK
	}
	ok := true
	services := map[string]bool{}
	for index := len(tx.backups) - 1; index >= 0; index-- {
		backup := tx.backups[index]
		if managedConfigCurrentGeneration[backup.spec.Path] != backup.generation {
			logf("managed config rollback skipped stale generation path=%s generation=%d current=%d", backup.spec.Path, backup.generation, managedConfigCurrentGeneration[backup.spec.Path])
			continue
		}
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
			continue
		}
		delete(managedConfigCurrentGeneration, backup.spec.Path)
		_ = os.Remove(backup.spec.Path + ".sha256")
		if service := strings.TrimSpace(backup.spec.ServiceName); service != "" {
			services[service] = services[service] || backup.hadPrevious
		}
	}
	for service, restore := range services {
		if restore {
			restartManagedService(service)
		} else {
			cleanupManagedService(service)
		}
	}
	tx.finished = true
	tx.rollbackOK = ok
	return ok
}

func (tx *managedConfigTransaction) commit() {
	if tx == nil {
		return
	}
	managedConfigMutationMu.Lock()
	defer managedConfigMutationMu.Unlock()
	tx.stateMu.Lock()
	defer tx.stateMu.Unlock()
	if tx.finished {
		return
	}
	for _, backup := range tx.backups {
		if managedConfigCurrentGeneration[backup.spec.Path] == backup.generation {
			delete(managedConfigCurrentGeneration, backup.spec.Path)
		}
	}
	tx.finished = true
	tx.rollbackOK = true
}
