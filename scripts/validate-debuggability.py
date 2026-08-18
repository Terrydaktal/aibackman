#!/usr/bin/env python3
"""Self-contained strict validator for AIBackman's debuggability contract."""

from __future__ import annotations

import argparse
import math
import sys
import tomllib
from pathlib import Path
from typing import Any


STATUSES = {
    "implemented_tested", "implemented_untested", "planned", "absent",
    "not_applicable", "waived",
}
REALIZED = {"implemented_tested", "implemented_untested"}
STRING_FIELDS = {
    "architecture": "fault_containment",
    "build": "identity",
    "live": "capabilities_command snapshot_command",
    "history": "schema",
    "audit_trail": (
        "event_schema actor_writer_and_reason attribution_policy transaction_binding "
        "attempted_write_policy provenance_and_deduplication change_representation "
        "tamper_evidence retention_and_access query_and_export sink_failure_policy "
        "cost_and_backpressure assurance_test"
    ),
    "reproduction": "replay_command",
    "postmortem": "retention_policy",
    "domain": "state_dump",
    "security": "authorization",
    "deployment_modes": "minimal_release observable_release global_runtime_switch",
    "performance_isolation": (
        "baseline_comparison minimal_mode_test runtime_disabled_test always_on_test"
    ),
    "instrumentation_policy": "facility_admission",
    "assurance": (
        "contract_test symbolization_test redaction_test overhead_test snapshot_test"
    ),
}
LIST_FIELDS = {
    "architecture": "state_owners mutation_points side_effect_boundaries",
    "errors": "causal_ids",
    "invariants": "release_checks progress_rules resource_balances",
    "resources": "declared_budgets",
    "reproduction": "recorded_inputs fault_injection",
    "domain": "cross_boundary_ids",
    "security": "redaction",
    "deployment_modes": "per_category_switches diagnostic_builds",
    "performance_isolation": "critical_hot_paths activated_mode_tests",
    "assurance": "synthetic_scenarios",
}
STATUS_FIELDS = {
    "errors": "typed_codes preserves_source_chain preserves_first_failure",
    "configuration": "effective_config decision_provenance dynamic_change_history",
    "build": "exact_artifact_retention symbols_and_unwind source_retrieval",
    "artifacts": "cache_identity atomic_publication generation_manifest",
    "live": "independent_of_failure_loop",
    "history": "flight_recorder drop_and_overwrite_reporting",
    "audit_trail": "mutation_audit direct_write_coverage",
    "concurrency": "task_registry lock_wait_introspection cross_process_correlation",
    "resources": "ownership_reporting high_water_reporting",
    "postmortem": "crash_capture includes_history oom_or_external_kill_detection",
    "recovery": "pre_repair_evidence restart_or_fallback_history last_failure_retention",
    "budgets": "measurement_status",
}
INT_FIELDS = {
    "live": "capture_timeout_ms",
    "history": "capacity_events",
    "audit_trail": "max_event_bytes max_audit_wait_ms max_storage_bytes_per_day",
    "security": "max_bundle_bytes retention_days",
    "budgets": "steady_memory_bytes",
    "performance_isolation": "disabled_hot_path_extra_instructions",
    "instrumentation_policy": (
        "max_steady_memory_bytes max_event_rate_per_second max_disk_bytes_per_day "
        "max_snapshot_pause_ms max_activation_ttl_seconds max_activated_capture_bytes"
    ),
}
NUMBER_FIELDS = {
    "audit_trail": "max_added_commit_p99_ms max_throughput_regression_percent",
    "budgets": "steady_cpu_percent activated_cpu_percent",
    "instrumentation_policy": (
        "max_steady_cpu_percent max_minimal_cpu_regression_percent "
        "max_runtime_disabled_cpu_regression_percent "
        "max_steady_p99_latency_regression_percent max_activated_cpu_percent"
    ),
}
BOOL_FIELDS = {
    "deployment_modes": (
        "optional_diagnostics_default_enabled lazy_buffer_allocation lazy_helper_start"
    ),
    "performance_isolation": (
        "preserves_release_optimization compile_time_exclusion_supported"
    ),
    "instrumentation_policy": (
        "synchronous_hot_path_io global_contended_event_index require_overhead_test "
        "promotion_requires_measurement"
    ),
}
SPECIAL_FIELDS = {
    "live": {"snapshot_consistency"},
    "instrumentation_policy": {"default_class"},
    "exceptions": {"items"},
}
TOP_FIELDS = {
    "schema_version", "template", "profile", "owner", "expected_failure_modes"
}
CONTROL_FIELDS = {"status", "reason", "implementation", "test"}
PROFILE_REQUIREMENTS = {
    "micro": {
        "errors.typed_codes", "errors.preserves_source_chain", "build.identity",
        "assurance.contract_test", "deployment_modes.minimal_release",
        "performance_isolation.minimal_mode_test",
    },
    "standard": {
        "errors.typed_codes", "errors.preserves_source_chain", "build.identity",
        "assurance.contract_test", "live.independent_of_failure_loop",
        "history.flight_recorder", "artifacts.generation_manifest",
        "assurance.overhead_test", "deployment_modes.minimal_release",
        "deployment_modes.observable_release", "performance_isolation.minimal_mode_test",
        "performance_isolation.runtime_disabled_test", "performance_isolation.always_on_test",
    },
    "stateful": {
        "errors.typed_codes", "errors.preserves_source_chain", "build.identity",
        "assurance.contract_test", "live.independent_of_failure_loop",
        "history.flight_recorder", "artifacts.generation_manifest",
        "assurance.overhead_test", "concurrency.task_registry",
        "resources.ownership_reporting", "domain.state_dump", "errors.causal_ids",
        "deployment_modes.minimal_release", "deployment_modes.observable_release",
        "deployment_modes.global_runtime_switch", "deployment_modes.per_category_switches",
        "performance_isolation.minimal_mode_test", "performance_isolation.runtime_disabled_test",
        "performance_isolation.always_on_test", "performance_isolation.activated_mode_tests",
    },
}
PROFILE_REQUIREMENTS["resilient"] = PROFILE_REQUIREMENTS["stateful"] | {
    "postmortem.crash_capture", "postmortem.includes_history", "build.source_retrieval",
    "concurrency.cross_process_correlation", "deployment_modes.diagnostic_builds",
}


def words(value: str) -> set[str]:
    return set(value.split())


def grouped_fields(groups: dict[str, str]) -> dict[str, set[str]]:
    return {table: words(fields) for table, fields in groups.items()}


STRING_FIELDS = grouped_fields(STRING_FIELDS)
LIST_FIELDS = grouped_fields(LIST_FIELDS)
STATUS_FIELDS = grouped_fields(STATUS_FIELDS)
INT_FIELDS = grouped_fields(INT_FIELDS)
NUMBER_FIELDS = grouped_fields(NUMBER_FIELDS)
BOOL_FIELDS = grouped_fields(BOOL_FIELDS)
TABLES = set().union(
    STRING_FIELDS, LIST_FIELDS, STATUS_FIELDS, INT_FIELDS, NUMBER_FIELDS,
    BOOL_FIELDS, SPECIAL_FIELDS,
)


def placeholder(value: str) -> bool:
    upper = value.upper()
    return not value.strip() or "TODO" in upper or "REPLACE_ME" in upper


def add(errors: list[str], condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def validate(path: Path) -> list[str]:
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    errors: list[str] = []
    expected_top = TOP_FIELDS | TABLES | {"controls"}
    add(errors, set(data) == expected_top,
        f"top-level keys differ: missing={sorted(expected_top - set(data))}, "
        f"unknown={sorted(set(data) - expected_top)}")
    add(errors, data.get("schema_version") == 5, "schema_version must be 5")
    add(errors, data.get("template") is False, "template must be false")
    add(errors, data.get("profile") in {"micro", "standard", "stateful", "resilient"},
        "profile is invalid")
    add(errors, isinstance(data.get("owner"), str) and not placeholder(data["owner"]),
        "owner must be a real non-empty string")
    failures = data.get("expected_failure_modes")
    add(errors, isinstance(failures, list) and bool(failures)
        and all(isinstance(item, str) and not placeholder(item) for item in failures),
        "expected_failure_modes must be a non-empty string array")

    for table_name in sorted(TABLES):
        table = data.get(table_name)
        if not isinstance(table, dict):
            errors.append(f"[{table_name}] must be a table")
            continue
        expected = set().union(
            STRING_FIELDS.get(table_name, set()), LIST_FIELDS.get(table_name, set()),
            STATUS_FIELDS.get(table_name, set()), INT_FIELDS.get(table_name, set()),
            NUMBER_FIELDS.get(table_name, set()), BOOL_FIELDS.get(table_name, set()),
            SPECIAL_FIELDS.get(table_name, set()),
        )
        add(errors, set(table) == expected,
            f"[{table_name}] keys differ: missing={sorted(expected - set(table))}, "
            f"unknown={sorted(set(table) - expected)}")
        for field in STRING_FIELDS.get(table_name, set()):
            value = table.get(field)
            add(errors, isinstance(value, str) and not placeholder(value),
                f"{table_name}.{field} must be a real non-empty string")
        for field in LIST_FIELDS.get(table_name, set()):
            value = table.get(field)
            add(errors, isinstance(value, list) and bool(value)
                and all(isinstance(item, str) and not placeholder(item) for item in value),
                f"{table_name}.{field} must be a non-empty string array")
        for field in STATUS_FIELDS.get(table_name, set()):
            add(errors, table.get(field) in STATUSES,
                f"{table_name}.{field} has an invalid status")
        for field in INT_FIELDS.get(table_name, set()):
            value = table.get(field)
            add(errors, isinstance(value, int) and not isinstance(value, bool) and value >= 0,
                f"{table_name}.{field} must be a non-negative integer")
        for field in NUMBER_FIELDS.get(table_name, set()):
            value = table.get(field)
            add(errors, isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value) and value >= 0,
                f"{table_name}.{field} must be a non-negative finite number")
        for field in BOOL_FIELDS.get(table_name, set()):
            add(errors, isinstance(table.get(field), bool),
                f"{table_name}.{field} must be a boolean")

    live = data.get("live", {})
    add(errors, live.get("snapshot_consistency") in
        {"atomic", "generation-consistent", "best-effort", "not_applicable"},
        "live.snapshot_consistency is invalid")
    policy = data.get("instrumentation_policy", {})
    add(errors, policy.get("default_class") in
        {"always_on", "activated", "diagnostic_build"},
        "instrumentation_policy.default_class is invalid")
    add(errors, policy.get("facility_admission") == "required",
        "instrumentation_policy.facility_admission must be required")
    for field, wanted in {
        "synchronous_hot_path_io": False,
        "global_contended_event_index": False,
        "require_overhead_test": True,
        "promotion_requires_measurement": True,
    }.items():
        add(errors, policy.get(field) is wanted,
            f"instrumentation_policy.{field} must be {str(wanted).lower()}")

    targets = {
        f"{table}.{field}"
        for table in set(STRING_FIELDS) | set(LIST_FIELDS)
        if table not in {"instrumentation_policy", "exceptions"}
        for field in STRING_FIELDS.get(table, set()) | LIST_FIELDS.get(table, set())
    }
    controls = data.get("controls")
    if not isinstance(controls, dict):
        errors.append("[controls] must be a table")
        controls = {}
    add(errors, set(controls) == targets,
        f"[controls] paths differ: missing={sorted(targets - set(controls))}, "
        f"unknown={sorted(set(controls) - targets)}")
    statuses: dict[str, str] = {
        f"{table}.{field}": data[table][field]
        for table, fields in STATUS_FIELDS.items()
        if isinstance(data.get(table), dict)
        for field in fields if data[table].get(field) in STATUSES
    }
    for target, record in controls.items():
        if not isinstance(record, dict):
            errors.append(f"controls.{target} must be a table")
            continue
        add(errors, set(record) == CONTROL_FIELDS,
            f"controls.{target} must contain exactly {sorted(CONTROL_FIELDS)}")
        add(errors, record.get("status") in STATUSES,
            f"controls.{target}.status is invalid")
        statuses[target] = record.get("status")
        for field in ("reason", "implementation", "test"):
            value = record.get(field)
            add(errors, isinstance(value, str) and not placeholder(value),
                f"controls.{target}.{field} must be a real non-empty string")

    exceptions = data.get("exceptions", {}).get("items")
    add(errors, isinstance(exceptions, list), "exceptions.items must be an array")
    exception_map: dict[str, str] = {}
    if isinstance(exceptions, list):
        for index, item in enumerate(exceptions):
            if not isinstance(item, dict):
                errors.append(f"exceptions.items[{index}] must be a table")
                continue
            add(errors, set(item) == {"control", "disposition", "reason"},
                f"exceptions.items[{index}] has invalid keys")
            control = item.get("control")
            disposition = item.get("disposition")
            reason = item.get("reason")
            add(errors, isinstance(control, str) and bool(control.strip()),
                f"exceptions.items[{index}].control must be non-empty")
            add(errors, disposition in {"not_applicable", "waived"},
                f"exceptions.items[{index}].disposition is invalid")
            add(errors, isinstance(reason, str) and not placeholder(reason),
                f"exceptions.items[{index}].reason must be real and non-empty")
            if isinstance(control, str) and isinstance(disposition, str):
                add(errors, control not in exception_map, f"duplicate exception for {control}")
                exception_map[control] = disposition
                add(errors, statuses.get(control) == disposition,
                    f"exception for {control} does not match its declared status")
    for target, status in statuses.items():
        if status in {"not_applicable", "waived"}:
            add(errors, exception_map.get(target) == status,
                f"{target}={status} requires a matching exception")

    profile = data.get("profile")
    if profile in PROFILE_REQUIREMENTS:
        for target in PROFILE_REQUIREMENTS[profile]:
            add(errors, statuses.get(target) in REALIZED | {"not_applicable", "waived"},
                f"profile={profile} requires {target} to be implemented or excepted")

    modes = data.get("deployment_modes", {})
    add(errors, modes.get("optional_diagnostics_default_enabled") is False,
        "optional diagnostics must default to disabled")
    add(errors, modes.get("lazy_buffer_allocation") is True,
        "diagnostic buffers must be lazy")
    add(errors, modes.get("lazy_helper_start") is True,
        "diagnostic helpers must be lazy")
    isolation = data.get("performance_isolation", {})
    add(errors, isolation.get("preserves_release_optimization") is True,
        "release optimization must be preserved")
    if statuses.get("performance_isolation.critical_hot_paths") in REALIZED:
        add(errors, isolation.get("disabled_hot_path_extra_instructions") == 0,
            "realized critical hot paths require zero disabled-path instructions")
    if data.get("budgets", {}).get("measurement_status") == "implemented_tested":
        add(errors, statuses.get("assurance.overhead_test") == "implemented_tested",
            "tested budgets require a tested overhead control")
    if statuses.get("deployment_modes.observable_release") in REALIZED:
        for target in (
            "performance_isolation.runtime_disabled_test",
            "performance_isolation.always_on_test",
        ):
            add(errors, statuses.get(target) in REALIZED,
                f"observable release requires realized {target}")
    if statuses.get("history.flight_recorder") in REALIZED:
        add(errors, data.get("history", {}).get("capacity_events", 0) > 0,
            "implemented flight recorder requires positive capacity")
        add(errors, statuses.get("history.drop_and_overwrite_reporting") in REALIZED,
            "implemented flight recorder requires drop reporting")
    if statuses.get("live.snapshot_command") in REALIZED:
        add(errors, data.get("live", {}).get("capture_timeout_ms", 0) > 0,
            "implemented snapshot command requires a positive timeout")
        add(errors, statuses.get("assurance.snapshot_test") in REALIZED,
            "implemented snapshot command requires a realized snapshot test")
    if statuses.get("audit_trail.mutation_audit") in REALIZED:
        audit_controls = {
            "event_schema", "actor_writer_and_reason", "attribution_policy",
            "transaction_binding", "attempted_write_policy", "provenance_and_deduplication",
            "change_representation", "direct_write_coverage", "tamper_evidence",
            "retention_and_access", "query_and_export", "sink_failure_policy",
            "cost_and_backpressure", "assurance_test",
        }
        for field in audit_controls:
            add(errors, statuses.get(f"audit_trail.{field}") in REALIZED | {"not_applicable", "waived"},
                f"implemented mutation audit requires audit_trail.{field}")
        for field in (
            "max_event_bytes", "max_added_commit_p99_ms", "max_throughput_regression_percent",
            "max_audit_wait_ms", "max_storage_bytes_per_day",
        ):
            add(errors, data.get("audit_trail", {}).get(field, 0) > 0,
                f"implemented mutation audit requires positive audit_trail.{field}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", nargs="?", type=Path, default=Path("debuggability.toml"))
    args = parser.parse_args()
    try:
        errors = validate(args.contract)
    except (OSError, tomllib.TOMLDecodeError) as error:
        print(f"error: could not read {args.contract}: {error}", file=sys.stderr)
        return 2
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"valid strict debuggability contract: {args.contract}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
