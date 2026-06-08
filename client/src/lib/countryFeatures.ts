export type CountryFeatureLike = {
  properties?: Record<string, unknown> | null;
};

const COUNTRY_CODE_FIELDS = ["ISO_A2", "WB_A2", "POSTAL", "FIPS_10_"];

export function normalizeCountryCode(value: unknown) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

export function countryFeatureHasCode(feature: CountryFeatureLike, countryCodes: Set<string>) {
  const properties = feature.properties || {};
  return COUNTRY_CODE_FIELDS.some((field) => {
    const code = normalizeCountryCode(properties[field]);
    return !!code && countryCodes.has(code);
  });
}
