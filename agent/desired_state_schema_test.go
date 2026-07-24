package main

import (
	"encoding/json"
	"testing"
)

func TestLegacyDesiredActionRecordForcesSchemaApply(t *testing.T) {
	var legacy desiredActionRecord
	if err := json.Unmarshal([]byte(`{"signature":"same","success":true,"updatedAt":1}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if !desiredActionRecordForcesApply(legacy, true) {
		t.Fatal("legacy record without applySchema did not force a real apply")
	}
	if desiredActionRecordMatches(legacy, true, "same") {
		t.Fatal("legacy record was reusable under the current apply schema")
	}
}

func TestDifferentDesiredActionSchemaForcesApply(t *testing.T) {
	record := newDesiredActionRecord("same", true)
	record.ApplySchema = currentDesiredActionApplySchema + 1
	if !desiredActionRecordForcesApply(record, true) {
		t.Fatal("different apply schema did not force a real apply")
	}
	if desiredActionRecordMatches(record, true, "same") {
		t.Fatal("different apply schema was reusable")
	}
}

func TestCurrentDesiredActionSchemaKeepsMatchingSuccessReusable(t *testing.T) {
	record := newDesiredActionRecord("same", true)
	if desiredActionRecordForcesApply(record, true) {
		t.Fatal("current apply schema unexpectedly forced execution")
	}
	if !desiredActionRecordMatches(record, true, "same") {
		t.Fatal("current apply schema lost the matching-record fast path")
	}
	if desiredActionRecordMatches(record, true, "different") {
		t.Fatal("current apply schema reused a different action signature")
	}
}

func TestMissingDesiredActionRecordStillAllowsNormalAdoptionPath(t *testing.T) {
	if desiredActionRecordForcesApply(desiredActionRecord{}, false) {
		t.Fatal("a fresh install without a record must not be treated as a schema migration")
	}
}
