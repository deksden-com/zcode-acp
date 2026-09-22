# Preserved native recovery experiment

This branch snapshots the previously uncommitted runtime changes from the older
fork checkout at `60af0d31e13076a313d9770f10aa70f7c94742cf`. It is archival,
unqualified and not a release candidate. Original working-tree files are left
untouched. Documentation of the new fork architecture is maintained separately.

The experiment covers causal backend errors, timeout/late-response correlation,
late allocation notifications, lazy session persistence, registry synchronization
and model/profile readback. Do not apply these files wholesale over upstream
v0.46.7. Its provider/model/session mechanics have evolved. Review each remaining
behavior with a failing regression before transplanting it. Native request
correlation belongs in the transport; replay/recovery decisions belong to the
consumer adapter. The upgrade candidate already preserves causal errors at its
native extension boundary.
