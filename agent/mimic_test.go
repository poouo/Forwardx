package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
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
rx-gro-hw: on
rx-vlan-offload: on
`
	want := []string{"gro", "lro", "rx-gro-hw", "tso", "tx"}
	if got := enabledMimicOffloads(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("enabledMimicOffloads() = %#v, want %#v", got, want)
	}
	mutableWant := []string{"gro", "rx-gro-hw", "tso", "tx"}
	if got := mutableMimicOffloads(raw); !reflect.DeepEqual(got, mutableWant) {
		t.Fatalf("mutableMimicOffloads() = %#v, want %#v", got, mutableWant)
	}
	receiveWant := []string{"gro", "lro", "rx-gro-hw"}
	if got := enabledMimicReceiveAggregationOffloads(raw); !reflect.DeepEqual(got, receiveWant) {
		t.Fatalf("enabledMimicReceiveAggregationOffloads() = %#v, want %#v", got, receiveWant)
	}
	mutableReceiveWant := []string{"gro", "rx-gro-hw"}
	if got := mutableMimicReceiveAggregationOffloads(raw); !reflect.DeepEqual(got, mutableReceiveWant) {
		t.Fatalf("mutableMimicReceiveAggregationOffloads() = %#v, want %#v", got, mutableReceiveWant)
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

func TestMimicOffloadDisableArgsProtectActiveInterface(t *testing.T) {
	want := []string{"-K", "eth0", "gro", "off", "lro", "off"}
	got, ok := mimicOffloadDisableArgs("eth0", []string{"gro", "lro", "gro"})
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("disable args = %#v, want %#v", got, want)
	}
	if _, ok := mimicOffloadDisableArgs("eth0", []string{"gro", "gso"}); ok {
		t.Fatal("disable args accepted a throughput offload")
	}
}

func TestMimicOffloadOperationLockSerializesOneInterface(t *testing.T) {
	lock := mimicOffloadOperationLock("test-mimic-lock0")
	lock.Lock()
	locked := true
	t.Cleanup(func() {
		if locked {
			lock.Unlock()
		}
	})

	ready := make(chan struct{})
	entered := make(chan struct{})
	go func() {
		other := mimicOffloadOperationLock("test-mimic-lock0")
		close(ready)
		other.Lock()
		close(entered)
		other.Unlock()
	}()
	<-ready
	select {
	case <-entered:
		t.Fatal("same-interface offload operation was not serialized")
	case <-time.After(20 * time.Millisecond):
	}
	lock.Unlock()
	locked = false
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("same-interface offload operation did not resume")
	}
}

func TestMimicNetworkFailuresRetryBeforeHealthySnapshots(t *testing.T) {
	if got := mimicNetworkTuneCacheWindow("mimicReceive=off"); got != mimicNetworkTuneInterval {
		t.Fatalf("healthy cache window=%s, want %s", got, mimicNetworkTuneInterval)
	}
	for _, message := range []string{"offload=ethtool-missing", "offload=inspect-failed", "mimicReceive=still-on:gro"} {
		if got := mimicNetworkTuneCacheWindow(message); got != mimicNetworkFailureRetryWindow {
			t.Fatalf("failure cache window=%s for %q, want %s", got, message, mimicNetworkFailureRetryWindow)
		}
	}
}

func TestMimicOffloadTunePlanDisablesOnlyReceiveAggregation(t *testing.T) {
	plan, ok := buildMimicOffloadTunePlan(
		[]string{"gro", "gso", "lro", "rx", "tso", "tx"},
		[]string{"gro", "lro"},
		nil,
		false,
	)
	if !ok {
		t.Fatal("fresh offload state was rejected")
	}
	if want := []string{"gro", "lro"}; !reflect.DeepEqual(plan.snapshot, want) || !reflect.DeepEqual(plan.disable, want) {
		t.Fatalf("fresh plan = %#v, want snapshot/disable %#v", plan, want)
	}
	if len(plan.restore) != 0 {
		t.Fatalf("fresh plan unexpectedly restores features: %#v", plan.restore)
	}
}

func TestMimicOffloadTunePlanMigratesLegacySnapshotOnce(t *testing.T) {
	legacy := []string{"gro", "gso", "lro", "rx", "tso", "tx"}
	plan, ok := buildMimicOffloadTunePlan(nil, nil, legacy, true)
	if !ok {
		t.Fatal("legacy offload state was rejected")
	}
	wantRestore := []string{"gso", "rx", "tso", "tx"}
	if !reflect.DeepEqual(plan.restore, wantRestore) {
		t.Fatalf("legacy restore = %#v, want %#v", plan.restore, wantRestore)
	}
	if len(plan.snapshot) != 0 || len(plan.disable) != 0 {
		t.Fatalf("legacy plan unexpectedly replaced state or disabled preserved offloads: %#v", plan)
	}

	plan, ok = buildMimicOffloadTunePlan(wantRestore, nil, legacy, true)
	if !ok {
		t.Fatal("migrated legacy offload state was rejected")
	}
	if len(plan.restore) != 0 || len(plan.disable) != 0 {
		t.Fatalf("periodic check would retune migrated state: %#v", plan)
	}
}

func TestMimicOffloadTunePlanRejectsUnknownLegacyFeature(t *testing.T) {
	if _, ok := buildMimicOffloadTunePlan(nil, nil, []string{"gro", "unsafe"}, true); ok {
		t.Fatal("unknown legacy offload state was accepted")
	}
}

func TestCaptureMimicOffloadStatePreservesFirstSnapshot(t *testing.T) {
	originalDir := mimicOffloadStateDir
	mimicOffloadStateDir = t.TempDir()
	t.Cleanup(func() { mimicOffloadStateDir = originalDir })

	if err := captureMimicOffloadState("eth0", []string{"gro", "tx"}); err != nil {
		t.Fatal(err)
	}
	if err := captureMimicOffloadState("eth0", []string{"rx"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(mimicOffloadStatePath("eth0"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(raw); got != "gro tx\n" {
		t.Fatalf("state = %q, want first snapshot", got)
	}
}
