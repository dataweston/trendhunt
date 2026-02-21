export interface LocationContext {
  zipCode: string;
  hasZip: boolean;
  yelpLocation: string;
  serpGeo: string;
  regionLabel: string;
  queryHint: string;
  locationHints: string[];
}

const ZIP_RE = /^\d{5}$/;

function envOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = (value || '').trim();
  return trimmed || fallback;
}

export function getLocationContext(zipRaw: string): LocationContext {
  const zip = (zipRaw || '').trim();
  const zipCode = ZIP_RE.test(zip) ? zip : '';

  const defaultRegionLabel = envOrDefault(process.env.DEFAULT_REGION_LABEL, 'United States');
  const defaultQueryHint = envOrDefault(process.env.DEFAULT_QUERY_HINT, defaultRegionLabel);
  const defaultSerpGeo = envOrDefault(process.env.DEFAULT_SERP_GEO, 'US');
  const defaultLocationHints = [
    defaultQueryHint,
    defaultRegionLabel,
    envOrDefault(process.env.DEFAULT_CITY_HINT, ''),
  ].filter(Boolean);

  if (!zipCode) {
    return {
      zipCode: '',
      hasZip: false,
      yelpLocation: defaultRegionLabel,
      serpGeo: defaultSerpGeo,
      regionLabel: defaultRegionLabel,
      queryHint: defaultQueryHint,
      locationHints: [...new Set(defaultLocationHints)],
    };
  }

  const hints = [zipCode, `near ${zipCode}`, ...defaultLocationHints].filter(Boolean);
  return {
    zipCode,
    hasZip: true,
    yelpLocation: `${zipCode}, USA`,
    serpGeo: defaultSerpGeo,
    regionLabel: `ZIP ${zipCode}`,
    queryHint: zipCode,
    locationHints: [...new Set(hints)],
  };
}

