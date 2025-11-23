import React from 'react';
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

// Minneapolis coordinates
const CENTER_LAT = 44.9778;
const CENTER_LNG = -93.2650;

export const GeoMap: React.FC<GeoMapProps> = ({ trends }) => {
  return (
    <div className="h-[400px] w-full rounded-xl overflow-hidden border border-slate-700 relative z-0">
      <MapContainer 
        center={[CENTER_LAT, CENTER_LNG]} 
        zoom={12} 
        scrollWheelZoom={false} 
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        
        {trends.map((trend) => {
            // Simulate lat/long based on neighborhood for demo purposes
            // In production, this would come from the TrendEntity.lat/lng
            let lat = CENTER_LAT;
            let lng = CENTER_LNG;
            
            if (trend.neighborhood === 'North Loop') { lat += 0.01; lng -= 0.01; }
            if (trend.neighborhood === 'Northeast') { lat += 0.02; lng += 0.01; }
            if (trend.neighborhood === 'Uptown') { lat -= 0.02; lng -= 0.02; }
            if (trend.neighborhood === 'Dinkytown') { lat += 0.01; lng += 0.02; }
            if (trend.neighborhood === 'Powderhorn') { lat -= 0.03; lng += 0.01; }

            return (
                <React.Fragment key={trend.id}>
                    <Circle 
                        center={[lat, lng]}
                        pathOptions={{ 
                            color: trend.unmetDemandScore > 70 ? '#ef4444' : '#10b981',
                            fillColor: trend.unmetDemandScore > 70 ? '#ef4444' : '#10b981',
                            fillOpacity: 0.4 
                        }}
                        radius={800 * (trend.demandScore / 100)}
                    />
                    <Marker position={[lat, lng]}>
                        <Popup>
                            <div className="text-slate-900">
                                <strong>{trend.term}</strong><br/>
                                Unmet Demand: {trend.unmetDemandScore}<br/>
                                Breakout Prob: {trend.breakoutProbability}%
                            </div>
                        </Popup>
                    </Marker>
                </React.Fragment>
            );
        })}
      </MapContainer>
    </div>
  );
};
