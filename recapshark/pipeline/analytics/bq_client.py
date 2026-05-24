"""
BigQuery client + project-level constants.

Owns: lazy BQ client factory + GCP service-account credential loading +
the project/dataset/table-glob constants every analytics query needs.

Imports allowed: stdlib + google.cloud.bigquery + google.oauth2.
No internal-package imports — this is the leaf module everything else builds on.
"""

import os
from functools import lru_cache

from google.cloud import bigquery
from google.oauth2 import service_account

from config import recapshark_bq_key_path

PROJECT_ID = "gcp-PROJECT-ID"
DATASET = "analytics_PROPERTY_ID"
TABLE_GLOB = f"`{PROJECT_ID}.{DATASET}.events_*`"

# Path to the GCP service-account JSON key. Override via env var in production.
# Default points to the file co-located with the pipeline package (one level
# above this module) for local dev convenience.
_DEFAULT_KEY_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "service-account.json",
)
KEY_FILE = recapshark_bq_key_path(_DEFAULT_KEY_PATH)


@lru_cache(maxsize=1)
def _client():
    credentials = service_account.Credentials.from_service_account_file(KEY_FILE)
    return bigquery.Client(project=PROJECT_ID, credentials=credentials)
