import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  MarkerType,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, ArrowRight } from "lucide-react";

interface Host {
  id: number;
  name: string;
  entryIp?: string;
  ipv4?: string;
  ipv6?: string;
  ip?: string;
}

interface MultiHopEditorProps {
  hosts: Host[];
  initialHopIds?: number[];
  onChange?: (hopHostIds: number[]) => void;
}

const ROLE_COLORS: Record<string, string> = {
  entry: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
  relay: "border-amber-500/40 bg-amber-500/10 text-amber-600",
  exit: "border-blue-500/40 bg-blue-500/10 text-blue-600",
};

const ROLE_LABELS: Record<string, string> = {
  entry: "入口",
  relay: "中转",
  exit: "出口",
};

function buildInitial(hosts: Host[], initialHopIds?: number[]) {
  const selectedIds = initialHopIds || [];
  const selected = selectedIds
    .map((id) => hosts.find((h) => h.id === id))
    .filter(Boolean) as Host[];

  const nodes: Node[] = selected.map((host, i) => ({
    id: `hop-${host.id}`,
    type: "default",
    position: { x: i * 220, y: 80 },
    data: {
      label: host.name,
      hostId: host.id,
      role: i === 0 ? "entry" : i === selected.length - 1 ? "exit" : "relay",
    },
  }));

  const edges: Edge[] = [];
  for (let i = 0; i < selected.length - 1; i++) {
    edges.push({
      id: `edge-${selected[i].id}-${selected[i + 1].id}`,
      source: `hop-${selected[i].id}`,
      target: `hop-${selected[i + 1].id}`,
      type: "smoothstep",
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#6366f1", strokeWidth: 2 },
    });
  }

  return { nodes, edges };
}

export default function MultiHopEditor({ hosts, initialHopIds, onChange }: MultiHopEditorProps) {
  const initial = useMemo(() => buildInitial(hosts, initialHopIds), [hosts, initialHopIds]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = buildInitial(hosts, initialHopIds);
    setNodes(newNodes);
    setEdges(newEdges);
  }, [hosts, initialHopIds, setNodes, setEdges]);

  const onConnect = useCallback(
    (conn: Connection) => {
      // Only allow one incoming and one outgoing per node
      const hasOutgoing = edges.some((e) => e.source === conn.source);
      const hasIncoming = edges.some((e) => e.target === conn.target);
      if (hasOutgoing || hasIncoming) return;
      setEdges((eds) => addEdge({ ...conn, type: "smoothstep", animated: true, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#6366f1", strokeWidth: 2 } }, eds));
    },
    [edges, setEdges],
  );

  const orderedHopIds = useMemo(() => {
    if (edges.length === 0) {
      return nodes.map((n) => n.data.hostId as number);
    }
    // Topological sort: find the node with no incoming edges (entry)
    const inDegree = new Map<string, number>();
    const outMap = new Map<string, string[]>();
    for (const e of edges) {
      inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
      const outs = outMap.get(e.source) || [];
      outs.push(e.target);
      outMap.set(e.source, outs);
    }
    // Start from node with no incoming edges
    const startNode = nodes.find((n) => !inDegree.has(n.id));
    if (!startNode) return nodes.map((n) => n.data.hostId as number);

    const order: string[] = [];
    const visited = new Set<string>();
    const queue = [startNode.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      order.push(id);
      const children = outMap.get(id) || [];
      queue.push(...children);
    }
    return order.map((nodeId) => {
      const node = nodes.find((n) => n.id === nodeId);
      return node?.data.hostId as number;
    }).filter(Boolean);
  }, [nodes, edges]);

  useEffect(() => {
    onChange?.(orderedHopIds);
  }, [orderedHopIds, onChange]);

  const addHost = (host: Host) => {
    if (nodes.some((n) => n.data.hostId === host.id)) return;
    const idx = nodes.length;
    const newNode: Node = {
      id: `hop-${host.id}-${Date.now()}`,
      type: "default",
      position: { x: idx * 220, y: 80 },
      data: { label: host.name, hostId: host.id, role: "relay" },
    };
    setNodes((nds) => [...nds, newNode]);

    // Auto-connect to last node if exists
    if (nodes.length > 0) {
      const lastNode = nodes[nodes.length - 1];
      setEdges((eds) => [...eds, {
        id: `edge-${lastNode.data.hostId}-${host.id}`,
        source: lastNode.id,
        target: newNode.id,
        type: "smoothstep",
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "#6366f1", strokeWidth: 2 },
      }]);
    }
  };

  const removeNode = (nodeId: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
  };

  const selectedHostIds = new Set(nodes.map((n) => n.data.hostId as number));
  const availableHosts = hosts.filter((h) => !selectedHostIds.has(h.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">多级隧道链路</span>
        <span className="text-xs text-muted-foreground">
          点击主机添加，拖拽端口连线，按链路顺序连接
        </span>
      </div>

      <div className="flex gap-3">
        {/* Host selector sidebar */}
        <div className="w-40 shrink-0 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">可用主机</p>
          {availableHosts.length === 0 && (
            <p className="text-[11px] text-muted-foreground italic">已全部添加</p>
          )}
          {availableHosts.map((host) => (
            <button
              key={host.id}
              className="flex w-full items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs hover:bg-accent transition-colors"
              onClick={() => addHost(host)}
            >
              <Plus className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{host.name}</span>
            </button>
          ))}
        </div>

        {/* Flow canvas */}
        <div className="flex-1 rounded-lg border border-border bg-card" style={{ height: 280 }}>
          {nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              从左侧点击主机添加到链路
            </div>
          ) : (
            <ReactFlow
              nodes={nodes.map((n, i) => {
                const role = i === 0 ? "entry" : i === nodes.length - 1 ? "exit" : "relay";
                return {
                  ...n,
                  data: { ...n.data, role },
                  style: {
                    padding: "10px 14px",
                    borderRadius: 8,
                    border: "2px solid",
                    fontSize: 12,
                    fontWeight: 500,
                    width: 140,
                  },
                };
              })}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              proOptions={{ hideAttribution: true }}
              nodesDraggable
              nodesConnectable
              elementsSelectable
              deleteKeyCode={["Backspace", "Delete"]}
              onNodesDelete={(deleted) => {
                // Already handled by React Flow's built-in deletion
              }}
            >
              <Controls showInteractive={false} />
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              <MiniMap
                style={{ width: 120, height: 80 }}
                nodeColor={(n) => {
                  const role = n.data?.role || "relay";
                  return role === "entry" ? "#10b981" : role === "exit" ? "#3b82f6" : "#f59e0b";
                }}
              />
            </ReactFlow>
          )}
        </div>
      </div>

      {/* Node role legend */}
      {nodes.length > 0 && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">链路顺序：</span>
          {nodes.map((n, i) => {
            const role = i === 0 ? "entry" : i === nodes.length - 1 ? "exit" : "relay";
            return (
              <span key={n.id} className="flex items-center gap-1">
                {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${ROLE_COLORS[role]}`}>
                  {(n.data as any).label as string} · {ROLE_LABELS[role]}
                </Badge>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
