#!/bin/bash

# --- Variables de entorno ---
export RENDER=true
export PORT=10000
export NODE_OPTIONS="--max-old-space-size=256 --expose-gc"

# --- Iniciar bot ---
node index.js
