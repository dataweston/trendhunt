import React, { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { TrendEntity } from '../types';
import L from 'leaflet';

// Fix for default Leaflet marker icons in React
// @ts-ignore
import icon from 'leaflet/dist/images/marker-icon.png';
// @ts-ignore
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
    iconUrl: icon,
    shadowUrl: iconShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41]
});

L.Marker.prototype.options.icon = DefaultIcon;

interface GeoMapProps {
  trends: TrendEntity[];
}

// Twin Cities metro center (between Mpls & St Paul)
const CENTER_LAT = 44.9537;
const CENTER_LNG = -93.1580;

// Comprehensive Twin Cities neighborhood/area coordinates
const NEIGHBORHOOD_COORDS: Record<string, [number, number]> = {
  // Minneapolis neighborhoods
  'North Loop':          [44.9870, -93.2740],
  'Northeast':           [44.9990, -93.2470],
  'NE Minneapolis':      [44.9990, -93.2470],
  'Downtown':            [44.9778, -93.2650],
  'Downtown Minneapolis':[44.9778, -93.2650],
  'Uptown':              [44.9480, -93.2980],
  'Lyn-Lake':            [44.9490, -93.2880],
  'Eat Street':          [44.9580, -93.2780],
  'Whittier':            [44.9560, -93.2740],
  'Dinkytown':           [44.9810, -93.2350],
  'Stadium Village':     [44.9750, -93.2290],
  'Powderhorn':          [44.9370, -93.2580],
  'Longfellow':          [44.9330, -93.2310],
  'Nokomis':             [44.9100, -93.2350],
  'South Minneapolis':   [44.9200, -93.2600],
  'North Minneapolis':   [45.0120, -93.2950],
  'Linden Hills':        [44.9230, -93.3170],
  'Southwest':           [44.9150, -93.3200],
  'Lake Street':         [44.9485, -93.2650],
  'Seward':              [44.9530, -93.2370],
  'Cedar-Riverside':     [44.9680, -93.2520],
  'Phillips':            [44.9600, -93.2620],
  'Prospect Park':       [44.9680, -93.2170],
  'Midtown':             [44.9480, -93.2600],
  'Calhoun-Isles':       [44.9500, -93.3100],
  'Kenwood':             [44.9650, -93.3100],
  'Lowry Hill':          [44.9680, -93.2960],
  'Warehouse District':  [44.9830, -93.2740],
  'Mill District':       [44.9795, -93.2540],
  'Elliot Park':         [44.9700, -93.2600],
  'Marcy-Holmes':        [44.9860, -93.2420],
  'Como':                [44.9900, -93.2190],
  'Columbia Heights':    [45.0480, -93.2470],
  'Robbinsdale':         [45.0320, -93.3380],
  'Crystal':             [45.0370, -93.3600],
  'Golden Valley':       [44.9910, -93.3490],
  'St. Louis Park':      [44.9490, -93.3480],
  'Hopkins':             [44.9250, -93.3980],
  'Edina':               [44.8890, -93.3500],
  'Richfield':           [44.8830, -93.2830],
  'Bloomington':         [44.8408, -93.2983],
  'Eden Prairie':        [44.8547, -93.4708],
  'Minnetonka':          [44.9213, -93.4687],
  'Plymouth':            [45.0105, -93.4555],
  'Maple Grove':         [45.0725, -93.4558],
  'Brooklyn Park':       [45.0942, -93.3563],
  'Brooklyn Center':     [45.0761, -93.3327],
  'Fridley':             [45.0861, -93.2633],
  'New Hope':            [45.0380, -93.3870],
  // St Paul neighborhoods
  'Downtown St Paul':    [44.9442, -93.0930],
  'St Paul':             [44.9537, -93.0900],
  'Saint Paul':          [44.9537, -93.0900],
  'West Side':           [44.9310, -93.0850],
  'Highland Park':       [44.9120, -93.1660],
  'Mac-Groveland':       [44.9330, -93.1660],
  'Macalester-Groveland':[44.9330, -93.1660],
  'Summit Hill':         [44.9390, -93.1360],
  'Summit-University':   [44.9500, -93.1370],
  'Cathedral Hill':      [44.9470, -93.1220],
  'Grand Avenue':        [44.9400, -93.1400],
  'Selby-Dale':          [44.9470, -93.1300],
  'Lowertown':           [44.9490, -93.0830],
  'Payne-Phalen':        [44.9720, -93.0710],
  'East Side':           [44.9680, -93.0490],
  'North End':           [44.9780, -93.1060],
  'Frogtown':            [44.9610, -93.1170],
  'Midway':              [44.9560, -93.1580],
  'University Ave':      [44.9550, -93.1500],
  'Hamline-Midway':      [44.9610, -93.1680],
  'Como Park':           [44.9780, -93.1430],
  'Merriam Park':        [44.9490, -93.1780],
  'Snelling-Hamline':    [44.9490, -93.1670],
  'West 7th':            [44.9300, -93.1200],
  'West Seventh':        [44.9300, -93.1200],
  // Suburbs — East
  'Maplewood':           [44.9530, -92.9950],
  'Roseville':           [45.0061, -93.1566],
  'Woodbury':            [44.9239, -92.9594],
  'Oakdale':             [44.9630, -92.9640],
  'Lake Elmo':           [44.9938, -92.8794],
  'Stillwater':          [45.0564, -92.8063],
  'White Bear Lake':     [45.0847, -93.0097],
  'North St Paul':       [45.0122, -92.9972],
  'South St Paul':       [44.8933, -93.0389],
  'West St Paul':        [44.8972, -93.1000],
  'Mendota Heights':     [44.8836, -93.1386],
  'Inver Grove Heights': [44.8483, -93.0428],
  'Cottage Grove':       [44.8277, -92.9439],
  'Eagan':               [44.8041, -93.1669],
  'Burnsville':          [44.7677, -93.2777],
  'Apple Valley':        [44.7319, -93.2177],
  'Lakeville':           [44.6497, -93.2427],
  'Savage':              [44.7792, -93.3363],
  'Shakopee':            [44.7980, -93.5269],
  'Prior Lake':          [44.7133, -93.4227],
  'Chanhassen':          [44.8622, -93.5308],
  // General / fallback
  'Minneapolis':         [44.9778, -93.2650],
  'All Neighborhoods':   [44.9537, -93.1580],
  'Twin Cities':         [44.9537, -93.1580],
  'Metro':               [44.9537, -93.1580],
};

/** Resolve a neighborhood string to lat/lng, with jitter to prevent stacking */
function resolveCoords(neighborhood: string, index: number): [number, number] {
  const key = (neighborhood || '').trim();
  const coords = NEIGHBORHOOD_COORDS[key];
  if (coords) {
    // Small deterministic jitter so multiple trends in same area don't stack
    const jitterLat = ((index * 7 + 3) % 11 - 5) * 0.002;
    const jitterLng = ((index * 13 + 7) % 11 - 5) * 0.002;
    return [coords[0] + jitterLat, coords[1] + jitterLng];
  }
  // Fuzzy match — check if neighborhood contains a known key
  for (const [name, c] of Object.entries(NEIGHBORHOOD_COORDS)) {
    if (key.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(key.toLowerCase())) {
      const jitterLat = ((index * 7 + 3) % 11 - 5) * 0.002;
      const jitterLng = ((index * 13 + 7) % 11 - 5) * 0.002;
      return [c[0] + jitterLat, c[1] + jitterLng];
    }
  }
  // Spread unknowns across metro with deterministic positioning
  const angle = (index * 137.508) * (Math.PI / 180); // golden angle
  const radius = 0.02 + (index % 5) * 0.008;
  return [CENTER_LAT + Math.cos(angle) * radius, CENTER_LNG + Math.sin(angle) * radius * 1.3];
}

export const GeoMap: React.FC<GeoMapProps> = ({ trends }) => {
  const trendCoords = useMemo(() => 
    trends.map((t, i) => ({ trend: t, coords: resolveCoords(t.neighborhood, i) })),
    [trends]
  );

  if (trends.length === 0) {
    return (
      <div className="h-[400px] w-full rounded-xl overflow-hidden border border-slate-700 relative z-0 flex items-center justify-center bg-slate-800/50">
        <p className="text-slate-500 text-sm">No trend data to display on map</p>
      </div>
    );
  }

  return (
    <div className="h-[400px] w-full rounded-xl overflow-hidden border border-slate-700 relative z-0">
      <MapContainer 
        center={[CENTER_LAT, CENTER_LNG]} 
        zoom={11} 
        scrollWheelZoom={false} 
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        
        {trendCoords.map(({ trend, coords: [lat, lng] }) => (
            <React.Fragment key={trend.id}>
                <Circle 
                    center={[lat, lng]}
                    pathOptions={{ 
                        color: trend.unmetDemandScore > 70 ? '#ef4444' : trend.unmetDemandScore > 40 ? '#f59e0b' : '#10b981',
                        fillColor: trend.unmetDemandScore > 70 ? '#ef4444' : trend.unmetDemandScore > 40 ? '#f59e0b' : '#10b981',
                        fillOpacity: 0.3 
                    }}
                    radius={600 + 600 * (trend.demandScore / 100)}
                />
                <Marker position={[lat, lng]}>
                    <Popup>
                        <div className="text-slate-900">
                            <strong>{trend.term}</strong><br/>
                            <span className="text-xs text-slate-600">{trend.neighborhood || 'Metro-wide'}</span><br/>
                            Unmet Demand: {trend.unmetDemandScore}<br/>
                            Breakout Prob: {trend.breakoutProbability}%
                        </div>
                    </Popup>
                </Marker>
            </React.Fragment>
        ))}
      </MapContainer>
    </div>
  );
};
