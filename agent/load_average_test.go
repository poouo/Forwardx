package main

import (
	"reflect"
	"testing"
)

func TestParseLoadAverage(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want []float64
	}{
		{"0.12 1.23 2.34 1/20 123", []float64{0.12, 1.23, 2.34}},
		{"0 0 0", []float64{0, 0, 0}},
		{" 1.5\t2.5 3.5\n", []float64{1.5, 2.5, 3.5}},
		{"", nil}, {"1 2", nil}, {"-1 2 3", nil},
		{"NaN 2 3", nil}, {"1 +Inf 3", nil}, {"1 2 invalid", nil},
	} {
		if got := parseLoadAverage(tc.raw); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("parseLoadAverage(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}
