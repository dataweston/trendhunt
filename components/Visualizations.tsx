import React, { useEffect, useRef, useMemo } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis
} from 'recharts';
import * as d3 from 'd3';
import { TrendEntity, Platform } from '../types';
import { PLATFORM_COLORS } from '../constants';

// --- Time Series Chart ---
interface TrendTimeSeriesProps {
  trend: TrendEntity;
}

export const TrendTimeSeries: React.FC<TrendTimeSeriesProps> = ({ trend }) => {
  // Transform data for Recharts
  const data = useMemo(() => {
    const weeks = trend.signals[0]?.history.length || 0;
    const chartData = [];
    for (let i = 0; i < weeks; i++) {
      const point: any = { week: trend.signals[0].history[i].week };
      trend.signals.forEach(signal => {
        point[signal.platform] = signal.history[i].value;
      });
      chartData.push(point);
    }
    return chartData;
  }, [trend]);

  return (
    <div className="h-[300px] w-full bg-slate-800/50 rounded-lg p-4 border border-slate-700">
      <h3 className="text-sm font-medium text-slate-400 mb-4">Cross-Platform Signal Velocity</h3>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="week" stroke="#94a3b8" />
          <YAxis stroke="#94a3b8" />
          <Tooltip 
            contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', color: '#f1f5f9' }}
            itemStyle={{ color: '#e2e8f0' }}
          />
          <Legend />
          {trend.signals.map(signal => (
            <Line
              key={signal.platform}
              type="monotone"
              dataKey={signal.platform}
              stroke={PLATFORM_COLORS[signal.platform]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 6 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

// --- Propagation Graph (D3) ---
interface PropagationGraphProps {
  trends: TrendEntity[];
}

// Define a Node interface that extends d3.SimulationNodeDatum
interface NetworkNode extends d3.SimulationNodeDatum {
  id: Platform;
  group: number;
  r: number;
}

// Define Link interface to handle D3 mutations
interface NetworkLink extends d3.SimulationLinkDatum<NetworkNode> {
  source: string | NetworkNode;
  target: string | NetworkNode;
  value: number;
}

export const PropagationGraph: React.FC<PropagationGraphProps> = () => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    // Define nodes (Platforms)
    const nodes: NetworkNode[] = [
      { id: Platform.TikTok, group: 1, r: 25 },
      { id: Platform.Pinterest, group: 1, r: 20 },
      { id: Platform.Reddit, group: 2, r: 22 },
      { id: Platform.GoogleSearch, group: 3, r: 30 },
      { id: Platform.Yelp, group: 4, r: 28 },
      { id: Platform.DoorDash, group: 4, r: 25 },
    ];

    // Define links (Influence Flow)
    // We cast this to allow D3 to replace string IDs with Node objects
    const links: NetworkLink[] = [
      { source: Platform.TikTok, target: Platform.GoogleSearch, value: 5 },
      { source: Platform.TikTok, target: Platform.DoorDash, value: 2 },
      { source: Platform.Reddit, target: Platform.GoogleSearch, value: 4 },
      { source: Platform.GoogleSearch, target: Platform.Yelp, value: 8 },
      { source: Platform.GoogleSearch, target: Platform.DoorDash, value: 6 },
      { source: Platform.Pinterest, target: Platform.GoogleSearch, value: 3 },
    ];

    const simulation = d3.forceSimulation<NetworkNode>(nodes)
      .force("link", d3.forceLink<NetworkNode, NetworkLink>(links).id((d) => d.id).distance(100))
      .force("charge", d3.forceManyBody().strength(-400))
      .force("center", d3.forceCenter(width / 2, height / 2));

    // Draw Arrows
    svg.append("defs").selectAll("marker")
      .data(["end"])
      .enter().append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 22) // Adjusted for node radius approx
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#64748b");

    const link = svg.append("g")
      .attr("stroke", "#64748b")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", d => Math.sqrt(d.value) * 2)
      .attr("marker-end", "url(#arrow)");

    const node = svg.append("g")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5)
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("r", d => d.r)
      .attr("fill", d => PLATFORM_COLORS[d.id as Platform] || "#94a3b8")
      .call(d3.drag<SVGCircleElement, NetworkNode>()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended));

    const label = svg.append("g")
      .selectAll("text")
      .data(nodes)
      .join("text")
      .attr("dy", 4)
      .attr("text-anchor", "middle")
      .text(d => d.id)
      .attr("fill", "white")
      .attr("font-size", "10px")
      .attr("font-weight", "bold")
      .attr("pointer-events", "none")
      .attr("stroke", "none");

    simulation.on("tick", () => {
      link
        .attr("x1", d => (d.source as NetworkNode).x!)
        .attr("y1", d => (d.source as NetworkNode).y!)
        .attr("x2", d => (d.target as NetworkNode).x!)
        .attr("y2", d => (d.target as NetworkNode).y!);

      node
        .attr("cx", d => d.x!)
        .attr("cy", d => d.y!);
        
      label
        .attr("x", d => d.x!)
        .attr("y", d => d.y!);
    });

    function dragstarted(event: d3.D3DragEvent<SVGCircleElement, NetworkNode, NetworkNode>, d: NetworkNode) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event: d3.D3DragEvent<SVGCircleElement, NetworkNode, NetworkNode>, d: NetworkNode) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event: d3.D3DragEvent<SVGCircleElement, NetworkNode, NetworkNode>, d: NetworkNode) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

  }, []);

  return (
    <div className="h-[300px] w-full bg-slate-800/50 rounded-lg border border-slate-700 relative overflow-hidden">
      <h3 className="absolute top-4 left-4 text-sm font-medium text-slate-400 z-10">Signal Propagation Network</h3>
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
};

// --- Abstract Geo Map (Hex Grid style) ---
export const GeoHexMap: React.FC = () => {
    // Mock grid for Minneapolis neighborhoods
    const grid = [
      { id: 'nl', x: 2, y: 1, name: 'North Loop', intensity: 0.9 },
      { id: 'ne', x: 3, y: 1, name: 'Northeast', intensity: 0.7 },
      { id: 'dt', x: 2, y: 2, name: 'Downtown', intensity: 0.4 },
      { id: 'up', x: 1, y: 3, name: 'Uptown', intensity: 0.6 },
      { id: 'wh', x: 2, y: 3, name: 'Whittier', intensity: 0.5 },
      { id: 'ph', x: 3, y: 3, name: 'Powderhorn', intensity: 0.3 },
      { id: 'dk', x: 3, y: 2, name: 'Dinkytown', intensity: 0.8 },
    ];

    return (
      <div className="h-[300px] w-full bg-slate-800/50 rounded-lg border border-slate-700 relative flex items-center justify-center">
        <h3 className="absolute top-4 left-4 text-sm font-medium text-slate-400">Unmet Demand Hotspots</h3>
        <div className="relative w-64 h-64">
            {grid.map((cell) => (
                <div
                    key={cell.id}
                    className="absolute w-16 h-16 border border-slate-900 flex items-center justify-center text-[10px] text-center font-bold text-white cursor-pointer hover:scale-110 transition-transform rounded-lg shadow-lg"
                    style={{
                        left: `${cell.x * 60}px`,
                        top: `${cell.y * 60}px`,
                        backgroundColor: `rgba(239, 68, 68, ${cell.intensity})`, // Red opacity based on demand intensity
                    }}
                    title={`${cell.name}: ${(cell.intensity * 100).toFixed(0)}% Unmet Demand`}
                >
                    {cell.name}
                </div>
            ))}
        </div>
        <div className="absolute bottom-4 right-4 flex items-center space-x-2">
            <div className="w-3 h-3 bg-red-500/20 rounded"></div>
            <span className="text-xs text-slate-400">Low</span>
            <div className="w-3 h-3 bg-red-500 rounded"></div>
            <span className="text-xs text-slate-400">High</span>
        </div>
      </div>
    );
};