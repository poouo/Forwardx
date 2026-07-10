package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSanitizeServiceNameAllowsSystemdTemplateInstance(t *testing.T) {
	if got := sanitizeServiceName("mimic@eth0"); got != "mimic@eth0" {
		t.Fatalf("sanitizeServiceName(mimic@eth0) = %q", got)
	}
	if got := sanitizeServiceName("mimic@eth0;reboot"); got != "" {
		t.Fatalf("sanitizeServiceName accepted unsafe value %q", got)
	}
}

func TestDefaultIPv4NetworkInterface(t *testing.T) {
	raw := []byte("Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n" +
		"lo 0000007F 00000000 0001 0 0 0 000000FF 0 0 0\n" +
		"eth0 00000000 010200C0 0003 0 0 100 00000000 0 0 0\n")
	if got := defaultIPv4NetworkInterface(raw); got != "eth0" {
		t.Fatalf("defaultIPv4NetworkInterface() = %q, want eth0", got)
	}
}

func TestDefaultIPv6NetworkInterface(t *testing.T) {
	raw := []byte(
		"20010db8000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000000 00000000 00000001 eth1\n" +
			"00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000000 00000000 00000001 ens3\n",
	)
	if got := defaultIPv6NetworkInterface(raw); got != "ens3" {
		t.Fatalf("defaultIPv6NetworkInterface() = %q, want ens3", got)
	}
}

func TestManagedMimicServicesFromConfigDir(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"eth0.conf":     "# Managed by ForwardX\nfilter = local=192.0.2.1:1234\n",
		"ens3.conf":     "log.verbosity = info\n# Managed by ForwardX\n",
		"example.conf":  "filter = local=192.0.2.1:1234\n",
		"bad name.conf": "# Managed by ForwardX\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	got := managedMimicServicesFromConfigDir(dir)
	want := []string{"mimic@ens3", "mimic@eth0"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("managedMimicServicesFromConfigDir() = %#v, want %#v", got, want)
	}
}
