# Snapshots de storage layout

Snapshot versionado del layout de almacenamiento de los contratos con estado
persistente (AUDIT M-3). CI ejecuta:

```sh
pnpm check:contracts:storage
```

El gate compara tipos de forma semántica (ignora IDs internos del AST), exige
que todas las entradas existentes conserven orden, slot, offset, etiqueta y
tipo, y sólo permite añadir variables al final. Antes de CUALQUIER upgrade de
implementación, inspeccionar también el diff explícito:

```sh
forge inspect AccountWebAuthnV2 storage-layout --json > /tmp/new.json
# diff contra el snapshot: los slots existentes NO pueden moverse ni cambiar de
# tipo; solo se permite añadir al final.
```

Si el diff muestra algo más que apéndices al final, el upgrade rompe el estado
de las cuentas desplegadas. Regenerar el snapshot sólo después de revisar la
compatibilidad y junto al cambio de contrato que lo justifica, en el mismo
commit. El gate complementa (no reemplaza) el test
`test_upgrade_preservesStateWithAppendedStorage`.
