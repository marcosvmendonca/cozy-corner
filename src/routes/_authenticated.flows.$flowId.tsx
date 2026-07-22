import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import ReactFlow, {
  Background, Controls, MiniMap, addEdge, useEdgesState, useNodesState,
  type Connection, type Node, type Edge, MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import { getFlow, saveFlow } from "@/lib/flows.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Loader2, Save, Plus, ArrowLeft, MessageSquare, HelpCircle, Split, User } from "lucide-react";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/flows/$flowId")({
  ssr: false,
  component: FlowEditor,
});

type NodeKind = "start" | "message" | "question" | "condition" | "handoff";
const nodeMeta: Record<NodeKind, { label: string; icon: any; color: string }> = {
  start:    { label: "Início",  icon: Plus,          color: "bg-brand text-brand-foreground" },
  message:  { label: "Mensagem", icon: MessageSquare, color: "bg-blue-500/10 text-blue-600" },
  question: { label: "Pergunta", icon: HelpCircle,    color: "bg-amber-500/10 text-amber-600" },
  condition:{ label: "Condição", icon: Split,         color: "bg-purple-500/10 text-purple-600" },
  handoff:  { label: "Humano",   icon: User,          color: "bg-emerald-500/10 text-emerald-600" },
};

function FlowEditor() {
  const { flowId } = Route.useParams();
  const navigate = useNavigate();
  const getFn = useServerFn(getFlow);
  const saveFn = useServerFn(saveFlow);

  const { data: flow, isLoading } = useQuery({ queryKey: ["flow", flowId], queryFn: () => getFn({ data: { id: flowId } }) });

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState<Node | null>(null);

  useEffect(() => {
    if (!flow) return;
    const g = (flow.graph as any) ?? { nodes: [], edges: [] };
    if (g.nodes?.length === 0) {
      // seed with a start node
      setNodes([{ id: "start", type: "default", position: { x: 40, y: 40 }, data: { label: "Início", kind: "start", text: "" } }]);
      setEdges([]);
    } else {
      setNodes(g.nodes ?? []);
      setEdges(g.edges ?? []);
    }
    setName(flow.name ?? "");
    setDescription(flow.description ?? "");
  }, [flow, setNodes, setEdges]);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, markerEnd: { type: MarkerType.ArrowClosed } }, eds)), [setEdges]);

  function addNode(kind: NodeKind) {
    const id = `${kind}-${Date.now()}`;
    setNodes((nds) => nds.concat({
      id, type: "default",
      position: { x: 200 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: { label: nodeMeta[kind].label, kind, text: "" },
    }));
  }

  function updateSelected(patch: Record<string, any>) {
    if (!sel) return;
    setNodes((nds) => nds.map((n) => n.id === sel.id ? { ...n, data: { ...n.data, ...patch } } : n));
    setSel((s) => s ? { ...s, data: { ...s.data, ...patch } } : s);
  }

  async function save() {
    setSaving(true);
    try {
      await saveFn({ data: { id: flowId, name, description, graph: { nodes, edges } } });
      toast.success("Fluxo salvo");
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  }

  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-3 border-b bg-surface px-4 py-3">
        <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/flows" })}><ArrowLeft className="h-4 w-4" /></Button>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs font-semibold" />
        <div className="ml-auto flex gap-2">
          {(Object.keys(nodeMeta) as NodeKind[]).filter(k => k !== "start").map((k) => {
            const Icon = nodeMeta[k].icon;
            return <Button key={k} variant="outline" size="sm" onClick={() => addNode(k)}><Icon className="mr-1 h-3.5 w-3.5" />{nodeMeta[k].label}</Button>;
          })}
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            Salvar
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-h-0">
          <ReactFlow
            nodes={nodes.map((n) => ({
              ...n,
              style: {
                borderRadius: 14,
                border: "1px solid var(--color-border)",
                background: "var(--color-surface)",
                padding: 10,
                minWidth: 160,
              },
              data: {
                ...n.data,
                label: (
                  <div className="text-left">
                    <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {(() => { const k = (n.data as any).kind as NodeKind; const Icon = nodeMeta[k]?.icon ?? MessageSquare; return <Icon className="h-3 w-3" />; })()}
                      {nodeMeta[(n.data as any).kind as NodeKind]?.label}
                    </div>
                    <div className="text-xs font-medium">
                      {(n.data as any).text || <span className="italic text-muted-foreground">Sem texto</span>}
                    </div>
                  </div>
                ) as any,
              },
            }))}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => setSel(n)}
            onPaneClick={() => setSel(null)}
            fitView
          >
            <Background gap={16} color="var(--color-border)" />
            <Controls />
            <MiniMap pannable zoomable className="!bg-surface" />
          </ReactFlow>
        </div>

        <aside className="min-h-0 overflow-y-auto border-l bg-surface p-4">
          <h3 className="text-sm font-semibold">Propriedades</h3>
          {sel ? (
            <div className="mt-3 space-y-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {nodeMeta[(sel.data as any).kind as NodeKind]?.label}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Texto</label>
                <Textarea rows={5} value={(sel.data as any).text ?? ""} onChange={(e) => updateSelected({ text: e.target.value })} />
              </div>
              <Button variant="destructive" size="sm" onClick={() => {
                setNodes((nds) => nds.filter((n) => n.id !== sel.id));
                setEdges((eds) => eds.filter((e) => e.source !== sel.id && e.target !== sel.id));
                setSel(null);
              }}>Remover nó</Button>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Descrição do fluxo</label>
                <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">Clique em um nó para editar.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
