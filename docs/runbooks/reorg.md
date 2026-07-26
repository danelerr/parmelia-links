# Runbook: reorganización de Arbitrum

## Detección y respuesta automática

Cada stream conserva bloque y hash. Si el hash del checkpoint diverge:

1. busca el ancestro común dentro de la ventana soportada;
2. marca bloques, eventos, receipts, ledger y snapshots posteriores como no
   canónicos;
3. elimina baselines de proyección posteriores al ancestro;
4. retrocede checkpoints/watermarks;
5. encola reconciliación de cuentas afectadas;
6. reingiere la rama nueva idempotentemente.

Un reorg fuera de ventana detiene el stream y requiere backfill verificado.

## Verificación operativa

```sql
SELECT chain_id, stream, detected_at, depth, status, affected_events,
       affected_accounts, common_ancestor_number, common_ancestor_hash
FROM chain_reorg_incidents
ORDER BY detected_at DESC
LIMIT 20;
```

Confirmar:

- el checkpoint apunta a un hash canónico;
- no existen dos receipts canónicos para el mismo `user_op_hash`;
- ledger/snapshots de la rama huérfana tienen `canonical=0`;
- payer y recipient no se duplicaron;
- outbox/push/webhook no se emitieron dos veces;
- el stream recuperó su lag normal.

No se corrige un reorg borrando filas o avanzando manualmente un cursor numérico.
Si no aparece ancestro, aislar backfill en `RPC_ARCHIVE_URLS` y mantener pagos
fuera de esa lane.
