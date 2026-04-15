#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/Users/stacyheo/.local/share/sf/client/2.130.9-43b21a1/bin:$PATH"

set -a
source /Users/stacyheo/costco-cafe-monitor/.env
set +a

node /Users/stacyheo/costco-cafe-monitor/src/index.js >> /Users/stacyheo/costco-cafe-monitor/data/monitor.log 2>&1
