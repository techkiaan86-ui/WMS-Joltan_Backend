import pandas as pd
import requests
import zipfile
import io
import json

# Load the ASIN / optionValue / SKU mapping table
try:
    data_df = pd.read_csv(data_csv_path, encoding="utf-8")
except UnicodeDecodeError:
    data_df = pd.read_csv(data_csv_path, encoding="latin1")
	
# Load the ASIN / optionValue / SKU mapping table
try:
    data_df = pd.read_csv(data_csv_path, encoding="utf-8")
except UnicodeDecodeError:
    data_df = pd.read_csv(data_csv_path, encoding="latin1")
    
url = row["customized-url"] # it was downloded from amazon sellercentral

response = requests.get(url)
response.raise_for_status()

matched_skus = []

# The customized URL downloads a ZIP file
with zipfile.ZipFile(io.BytesIO(response.content)) as zip_file:

    # Find and read each JSON file inside the ZIP
    for file_name in zip_file.namelist():
        if not file_name.endswith(".json"):
            continue

        with zip_file.open(file_name) as json_file:
            data = json.load(json_file)

        # Read the product ASIN
        asin = data.get("asin")

        # Navigate to the selected customization options
        customization_info = data.get("customizationInfo", {})
        version = customization_info.get("version3.0", {})
        surfaces = version.get("surfaces", [])

        option_values = []

        for surface in surfaces:
            for area in surface.get("areas", []):
                if area.get("customizationType") == "Options":
                    option_value = area.get("optionValue")

                    if option_value:
                        option_values.append(option_value)

        # Match each selected option using ASIN + optionValue
        for option_value in option_values:
            matching_row = data_df[
                (data_df["ASIN"] == asin)
                & (data_df["optionValue"] == option_value)
            ]

            if not matching_row.empty:
                sku = matching_row.iloc[0]["SKU"]

                # This value means the customer selected no item
                if sku != "DISP_No_thx":
                    matched_skus.append(sku)

# List all matched SKUs
print(matched_skus)

