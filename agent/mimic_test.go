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

func TestEnabledMimicOffloads(t *testing.T) {
	raw := `Features for eth0:
rx-checksumming: off
tx-checksumming: on
tcp-segmentation-offload: on
generic-segmentation-offload: off
generic-receive-offload: on
large-receive-offload: on [fixed]
rx-vlan-offload: on
`
	want := []string{"gro", "lro", "tso", "tx"}
	if got := enabledMimicOffloads(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("enabledMimicOffloads() = %#v, want %#v", got, want)
	}
}

func TestValidMimicInterfaceNameRejectsStatePathTraversal(t *testing.T) {
	if !validMimicInterfaceName("eth0.100") {
		t.Fatal("valid VLAN interface was rejected")
	}
	for _, iface := range []string{".", "..", "eth0/../lo"} {
		if validMimicInterfaceName(iface) {
			t.Fatalf("unsafe interface %q was accepted", iface)
		}
	}
}

func TestMimicOffloadRestoreArgsOnlyEnableKnownFeatures(t *testing.T) {
	args, ok := mimicOffloadRestoreArgs("eth0", []string{"gro", "tx", "gro"})
	if !ok {
		t.Fatal("valid saved offload state was rejected")
	}
	want := []string{"-K", "eth0", "gro", "on", "tx", "on"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("restore args = %#v, want %#v", args, want)
	}
	if _, ok := mimicOffloadRestoreArgs("eth0", []string{"unsafe"}); ok {
		t.Fatal("unknown saved offload feature was accepted")
	}
}
