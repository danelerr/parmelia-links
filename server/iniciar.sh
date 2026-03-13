#!/bin/bash

# 1. Extraemos la llave primero y le damos tiempo a la terminal de manejar el prompt
echo "Desbloqueando keystore..."
LLAVE_CRUDA=$(cast wallet private-key --account wallet-0x75)

# 2. Sanear la llave directamente en bash (aseguramos el 0x y quitamos saltos de línea de Windows)
LLAVE_LIMPIA=$(echo "$LLAVE_CRUDA" | tr -d '\r' | tr -d '\n')
if [[ $LLAVE_LIMPIA != 0x* ]]; then
  LLAVE_LIMPIA="0x$LLAVE_LIMPIA"
fi

# 3. Lanzamos Wrangler inyectando la variable ya procesada y lista
echo "Inyectando llave en Cloudflare Workers..."
npx wrangler dev --var PRIVATE_KEY:"$LLAVE_LIMPIA"