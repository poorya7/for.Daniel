"""
Live feed + facet endpoints.

Owns: GET /facets (city/country/florida-cities option list for dashboard
filters) and GET /feed (most-recent events stream).

Reads from: bq_client (_client, TABLE_GLOB), filters (SUFFIX_WHERE,
EVENT_PARAMS_STRUCT, suffix_range, filter_where_clause, filter_params),
pagination (row_to_event).

Imports allowed: stdlib + fastapi + google.cloud.bigquery + sibling
analytics modules. No upstream pipeline modules.
"""

from fastapi import Query as FQuery
from google.cloud import bigquery

from . import router
from .bq_client import _client, TABLE_GLOB
from .filters import (
    SUFFIX_WHERE,
    EVENT_PARAMS_STRUCT,
    suffix_range,
    filter_where_clause,
    filter_params,
)
from .pagination import row_to_event


@router.get("/facets")
def facets(days: int = FQuery(30, ge=1, le=365)):
    """All distinct cities (with region) + countries — for filter dropdowns.
    Default window: 30 days (filters reflect what you can recently exclude).
    """
    start_suffix, end_suffix = suffix_range(days)
    query = f"""
    SELECT
      geo.city AS city,
      geo.region AS region,
      geo.country AS country,
      COUNT(*) AS event_count
    FROM {TABLE_GLOB}
    WHERE {SUFFIX_WHERE}
      AND user_pseudo_id IS NOT NULL
    GROUP BY city, region, country
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("start_suffix", "STRING", start_suffix),
        bigquery.ScalarQueryParameter("end_suffix", "STRING", end_suffix),
    ])
    cities, countries, fl_cities = [], set(), set()
    for r in _client().query(query, job_config=job_config).result():
        if r.country:
            countries.add(r.country)
        if r.city and r.city not in ("", "(not set)"):
            cities.append({"city": r.city, "region": r.region, "country": r.country, "events": r.event_count})
            if r.region == "Florida":
                fl_cities.add(r.city)
    return {
        "cities": sorted(cities, key=lambda x: -x["events"]),
        "countries": sorted(countries),
        "florida_cities": sorted(fl_cities),
    }


@router.get("/feed")
def live_feed(
    limit: int = FQuery(100, ge=1, le=500),
    days: int = FQuery(7, ge=1, le=365),
    exclude_cities: str = FQuery(""),
    exclude_countries: str = FQuery(""),
    hide_unknown_cities: bool = FQuery(False),
    hide_owner: bool = FQuery(False),
):
    """Most recent events, filtered. Default window: last 7 days."""
    query = f"""
    SELECT
      TIMESTAMP_MICROS(event_timestamp) AS ts,
      event_name,
      user_pseudo_id,
      device.category AS device,
      geo.city AS city,
      geo.region AS region,
      geo.country AS country,
      {EVENT_PARAMS_STRUCT}
    FROM {TABLE_GLOB}
    WHERE {filter_where_clause()}
    ORDER BY event_timestamp DESC
    LIMIT @limit
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            *filter_params(exclude_cities, exclude_countries, hide_unknown_cities, hide_owner, days),
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
        ]
    )
    return {"rows": [row_to_event(r) for r in _client().query(query, job_config=job_config).result()]}
