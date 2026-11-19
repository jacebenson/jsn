# Bounded source corrections after c3b2c76439c92660a6b36db60bf143d923ff8540

Verified auditor M1 directly against preserved Custom Table Guide extraction lines 42–47, 144–154 and 156–171; verified L1 against Integration Hub extraction lines 18–32 and 42–72. These are preserved text checks, not fresh PDF-byte or visual-layout verification.

- Grandfathered definition now separates permissible purpose under the prevailing contract from allocation eligibility. Narrowed definition section provenance; retained separate Starter restrictions.
- Both current Credit Pack API daily quantities are null, with explicit availability and footnote-2 consumption references. Starter quantity and FedRamp/GCC Boomi exception unchanged.
- Canonical record provenance records these distinctions; existing sync script regenerated the byte-identical bundled inventory. No ITOM schema change; README documents combined-status convention. Inventory status counts remain 30 normalized / 1 partial.

Actual checks on corrected files:

- New two semantic regressions first failed against old bundled data (5 passed / 2 failed), then focused `node --test test/schedule-cache.test.js test/subscription*.test.js` from cli passed **37 / 37**, no skips/failures (includes real CLI HTTP/cache fixture).
- `npm run lint` from cli: exit 0.
- Ruby **3.4.10**, shared task-local locked gems: `bundle exec rails test test/subscription_schedules_test.rb`: **8 runs / 118 assertions**, no failures/errors/skips. Existing requests exercise current canonical records.
- `git diff --check`: exit 0.
- Rails service runner measured current artifact: **221370 bytes**, **32 records**, catalog revision `ab56d4fab6a590bb9fb056766e6f877a50228d2881a3d78c72820ef0af63d521`, artifact SHA256 `c779b3c336e0be5a87e82df9fbc289b2dd624884ac67961d1600b06d90e95ed1`.

The preceding integration report's artifact SHA256 `de248b700ef20b3ed78528eaa6fce6eb9c7882fac94e69fb57acc57b7fafad6d` is superseded by this correction; its old byte/revision receipts do not describe the corrected artifact. Prior full-suite/browser receipts were not rerun here. No push, external writes, deployment, publication or new rights/pricing claim. Untracked original research preserved. Independent Holly review of the final commit remains required.
