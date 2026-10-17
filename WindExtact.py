from shapely.geometry import MultiPoint, multipoint
import openmeteo_requests

import pandas as pd
import requests_cache
from retry_requests import retry
import re

coord_st_Nazaire_dms = ["-2,36.694", "47,9.051"]
coord_st_brieuc_dms = ["-2,32.60", "48,51.38"]
coord_st_Fecamp_dms = ["0,13.1", "49,53.62"]

coord_st_Noirmoutier_dms = [["2,36.7","46,53.3"],
                            ["2,32.1","46,56.9"],
                            ["2,24.7","46,50.9"],
                            ["2,29.7","46,48.5"]]


def dm_str_to_decimal(s, negative=False):
    deg, minutes = s.split(",")
    value = abs(float(deg)) + float(minutes) / 60
    return -value if negative or deg.strip().startswith("-") else value



# (lon, lat) in decimal degrees; longitude is west, so negative
points = [
    (dm_str_to_decimal(lon, negative=True), dm_str_to_decimal(lat))
    for lon, lat in coord_st_Noirmoutier_dms
]

center_lon = sum(p[0] for p in points) / len(points)
center_lat = sum(p[1] for p in points) / len(points)


sites = {
    "Saint-Nazaire": coord_st_Nazaire_dms,
    "Saint-Brieuc":  coord_st_brieuc_dms,
    "Fécamp":        coord_st_Fecamp_dms,
}


def get_center(table_coordinates):
    """
    Get the center of a table of coordinates
    :param table_coordinates: list of coordinates [[lon, lat], [lon, lat], ...]
    :return: [lon, lat]
    """
    points = MultiPoint([(0.0, 0.0), (1.0, 1.0)])
    return points.centroid #True centroid, not necessarily an existing point


cache_session = requests_cache.CachedSession('.cache', expire_after = -1)
retry_session = retry(cache_session, retries = 5, backoff_factor = 0.2)
openmeteo = openmeteo_requests.Client(session = retry_session)

# (lon, lat) in decimal degrees
decimal_coords = {
    name: (dm_str_to_decimal(lon), dm_str_to_decimal(lat))
    for name, (lon, lat) in sites.items()
}

decimal_coords["Noirmoutier"] = (center_lon, center_lat)
for name, (lon, lat) in decimal_coords.items():
    print(f"{name:14s} lon={lon:.5f}  lat={lat:.5f}")


url = "https://archive-api.open-meteo.com/v1/archive"

for name, (lon, lat) in decimal_coords.items():
    params = {
	    "latitude": lat,
	    "longitude": lon,
	    "start_date": "2023-03-03",
	    "end_date": "2026-10-01",
	    "hourly": ["temperature_2m", "wind_speed_100m", "wind_direction_100m", "wind_gusts_10m", "wind_speed_10m", "wind_direction_10m", "relative_humidity_2m"],
	    "timezone": "Europe/Berlin",
    }


    responses = openmeteo.weather_api(url, params = params)

    # Process first location. Add a for-loop for multiple locations or weather models
    response = responses[0]
    print(f"\n{name} ({lat}, {lon})")
    print(f"Coordinates: {response.Latitude()}°N {response.Longitude()}°E")
    print(f"Elevation: {response.Elevation()} m asl")
    print(f"Timezone: {response.Timezone()}{response.TimezoneAbbreviation()}")
    print(f"Timezone difference to GMT+0: {response.UtcOffsetSeconds()}s")

    # Process hourly data. The order of variables needs to be the same as requested.
    hourly = response.Hourly()
    hourly_wind_speed_100m = hourly.Variables(1).ValuesAsNumpy()
    hourly_wind_direction_100m = hourly.Variables(2).ValuesAsNumpy()
    hourly_wind_gusts_10m = hourly.Variables(3).ValuesAsNumpy()


    hourly_data = {
	    "date": pd.date_range(
		    start = pd.to_datetime(hourly.Time(), unit = "s", utc = True),
		    end =  pd.to_datetime(hourly.TimeEnd(), unit = "s", utc = True),
		    freq = pd.Timedelta(seconds = hourly.Interval()),
		    inclusive = "left"
	    ).tz_convert(response.Timezone().decode())
    }



    hourly_data["hourly_wind_speed_100m"] = hourly_wind_speed_100m
    hourly_data["hourly_wind_direction_100m"] = hourly_wind_direction_100m
    hourly_data["hourly_wind_gusts_10m"] = hourly_wind_gusts_10m


    hourly_dataframe = pd.DataFrame(data = hourly_data)
    hourly_dataframe.to_csv(f"{name}_hourly_data.csv", index=False)
    print("\nHourly data\n", hourly_dataframe)