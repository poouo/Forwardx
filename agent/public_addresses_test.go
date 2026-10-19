package main

import (
	"reflect"
	"testing"
)

func TestPublicAddressInventoryFiltering(t *testing.T) {
	for _, ip := range []string{"10.0.0.1", "192.168.0.1", "172.16.1.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "100.127.255.255", "198.18.0.1", "0.1.2.3", "224.0.0.1", "255.255.255.255", "invalid", "::1"} {
		if got := publicIPv4Literal(ip); got != "" {
			t.Errorf("accepted non-public IPv4 %q", ip)
		}
	}
	if got := canonicalPublicAddresses([]string{"8.8.8.8", "1.1.1.1", "8.8.8.8", "10.0.0.1"}, false); !reflect.DeepEqual(got, []string{"1.1.1.1", "8.8.8.8"}) {
		t.Fatal(got)
	}
	if got := canonicalPublicAddresses([]string{"2606:4700:4700:0:0:0:0:1111", "2606:4700:4700::1111", "fe80::1", "fd00::1", "::1", "1.1.1.1"}, true); !reflect.DeepEqual(got, []string{"2606:4700:4700::1111"}) {
		t.Fatal(got)
	}
}

func TestLocalPublicAddressAliases(t *testing.T) {
	data := []byte(`[
	 {"flags":["UP","BROADCAST"],"addr_info":[
	  {"family":"inet","scope":"global","local":"8.8.8.8"},
	  {"family":"inet","scope":"global","local":"1.1.1.1"},
	  {"family":"inet","scope":"global","local":"1.1.1.1"},
	  {"family":"inet","scope":"global","local":"10.0.0.1"},
	  {"family":"inet6","scope":"global","local":"2606:4700:4700::1111"},
	  {"family":"inet6","scope":"global","local":"2606:4700:4700::2222","temporary":true},
	  {"family":"inet6","scope":"global","local":"2606:4700:4700::3333","flags":["deprecated"]},
	  {"family":"inet6","scope":"global","local":"2606:4700:4700::4444","tentative":true},
	  {"family":"inet6","scope":"global","local":"2606:4700:4700::5555","dadfailed":true},
	  {"family":"inet6","scope":"link","local":"fe80::1"}]},
	 {"flags":["BROADCAST"],"addr_info":[{"family":"inet","scope":"global","local":"9.9.9.9"}]},
	 {"flags":["UP","LOOPBACK"],"addr_info":[{"family":"inet","scope":"global","local":"4.4.4.4"}]}
	]`)
	v4, v6, err := parseLocalPublicAddresses(data)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(v4, []string{"1.1.1.1", "8.8.8.8"}) {
		t.Fatal(v4)
	}
	if !reflect.DeepEqual(v6, []string{"2606:4700:4700::1111"}) {
		t.Fatal(v6)
	}
	if _, _, err := parseLocalPublicAddresses([]byte(`broken`)); err == nil {
		t.Fatal("invalid JSON accepted")
	}
}

func TestPublicAddressInventorySnapshot(t *testing.T) {
	publicIPMu.Lock()
	before4, before6 := publicIPv4AddressesCache, publicIPv6AddressesCache
	publicIPv4AddressesCache, publicIPv6AddressesCache = []string{"1.1.1.1"}, []string{"2606:4700:4700::1111"}
	publicIPMu.Unlock()
	defer func() {
		publicIPMu.Lock()
		publicIPv4AddressesCache, publicIPv6AddressesCache = before4, before6
		publicIPMu.Unlock()
	}()
	v4, v6 := publicAddressInventory()
	v4[0], v6[0] = "mutated", "mutated"
	v4, v6 = publicAddressInventory()
	if v4[0] != "1.1.1.1" || v6[0] != "2606:4700:4700::1111" {
		t.Fatal("inventory leaked mutable cache")
	}
}
