# Referencia técnica: clientes

### Receipts / customers / parking

`src/customers/` holds recurring-customer billing (monthly parking, renters, receipt payments,
payment-history-on-account). `src/parking/` owns the spots: `ParkingOwner` (a garage spot belonging to a customer,
optionally rented out via `rent`/`rentActive`), `ParkingRenter`, and the customer-defined
`OwnerParkingType`/`RenterParkingType` price tiers. Owner/renter create-update logic was extracted out of
`CustomersService` into `ParkingOwnersService`/`ParkingRentersService` (see the "Reemplaza el bloque OWNER de
CustomersService" comments) — put new spot logic there, not back in customers.

**Entity names diverge from table names here** because of history under `synchronize: true`: `ParkingOwner` →
table `vehicles`, `ParkingRenter` → `vehicle_renters`, `OwnerParkingType` → `parking_types` (with its `name`
property mapped to the physical column `parkingType`). On `Customer` the relations are
`parkingOwners`/`parkingRenters`. Raw SQL, RLS migrations and relation strings must use these physical names.
