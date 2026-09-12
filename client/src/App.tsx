import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Users,
  Radio,
  Zap,
  Activity,
  Sliders,
  RefreshCw,
  Layers,
  Flame,
  Heart,
  PartyPopper,
  Rocket,
  ThumbsUp,
  Wifi,
  WifiOff,
  Minimize2,
  Maximize2,
  Sparkles,
} from 'lucide-react';
import { createRoom, RoomHandle, ClientMetrics } from './connection';
import {
  InterpolationManager,
  InterpolationMode,
} from './interpolation';
import { CanvasRenderer } from './render';
import { RemotePeerState } from './protocol';

const REACTION_EMOJIS = [
  { emoji: '🔥', label: 'Fire', icon: Flame, color: '#f43f5e' },
  { emoji: '❤️', label: 'Love', icon: Heart, color: '#ec4899' },
  { emoji: '🎉', label: 'Party', icon: PartyPopper, color: '#a855f7' },
  { emoji: '⚡', label: 'Hype', icon: Zap, color: '#eab308' },
  { emoji: '🚀', label: 'Rocket', icon: Rocket, color: '#06b6d4' },
  { emoji: '👏', label: 'Clap', icon: ThumbsUp, color: '#10b981' },
];

const PRESET_COLORS = [
  '#f43f5e',
  '#ec4899',
  '#8b5cf6',
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#f97316',
];

// Generate persistent clientId for this tab session
function getOrCreateClientId(): string {
  let id = sessionStorage.getItem('fan_sync_client_id');
  if (!id) {
    id = 'user_' + Math.random().toString(36).substring(2, 9);
    sessionStorage.setItem('fan_sync_client_id', id);
  }
  return id;
}

export default function App() {
  const [clientId] = useState(getOrCreateClientId);
  const [name, setName] = useState(() => {
    return 'Fan-' + clientId.slice(-4).toUpperCase();
  });
  const [color, setColor] = useState(() => {
    const idx = Math.floor(Math.random() * PRESET_COLORS.length);
    return PRESET_COLORS[idx];
  });
  const [roomId, setRoomId] = useState('watch-party-42');

  // Interactive state
  const [hypeTotal, setHypeTotal] = useState(128);
  const [selectedEmoji, setSelectedEmoji] = useState('🔥');
  const [activePeers, setActivePeers] = useState<RemotePeerState[]>([]);
  const [metrics, setMetrics] = useState<ClientMetrics>({
    rttMs: 0,
    jitterMs: 0,
    packetsSent: 0,
    packetsReceived: 0,
    remoteUpdatesPerSec: 0,
    connected: false,
  });

  // Diagnostics & Simulation Controls
  const [interpMode, setInterpMode] = useState<InterpolationMode>('extrapolation');
  const [bufferDelay, setBufferDelay] = useState<number>(50);
  const [simLatency, setSimLatency] = useState<number>(0);
  const [simJitter, setSimJitter] = useState<number>(0);
  const [simLoss, setSimLoss] = useState<number>(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [presenceOpen, setPresenceOpen] = useState(false);

  // References
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const interpManagerRef = useRef<InterpolationManager>(new InterpolationManager());
  const roomRef = useRef<RoomHandle | null>(null);
  const localCursorPosRef = useRef<{ x: number; y: number } | null>(null);

  // Sync settings into interpolation manager & simulated network
  useEffect(() => {
    interpManagerRef.current.mode = interpMode;
    interpManagerRef.current.bufferDelayMs = bufferDelay;
  }, [interpMode, bufferDelay]);

  useEffect(() => {
    if (roomRef.current) {
      roomRef.current.setSimulatedNetwork({
        latencyMs: simLatency,
        jitterMs: simJitter,
        packetLossRate: simLoss / 100,
      });
    }
  }, [simLatency, simJitter, simLoss]);

  // Connect to room
  useEffect(() => {
    const interp = interpManagerRef.current;
    interp.clear();

    const room = createRoom({
      roomId,
      clientId,
      name,
      color,
      throttleIntervalMs: 30, // 33Hz cursor throttling
    });
    roomRef.current = room;

    // Apply current network degradation settings
    room.setSimulatedNetwork({
      latencyMs: simLatency,
      jitterMs: simJitter,
      packetLossRate: simLoss / 100,
    });

    // Handle remote actions
    const unsubAction = room.onRemoteAction((remoteId, action) => {
      if (action.type === 'cursor') {
        interp.pushPeerCursor(remoteId, action.x, action.y, action.seq ?? 0);
      } else if (action.type === 'reaction') {
        const peer = interp.getPeer(remoteId);
        rendererRef.current?.addReactionBurst(
          action.emoji,
          action.x,
          action.y,
          peer?.color || '#818cf8'
        );
      }
    });

    // Handle full state snapshots (when joining)
    const unsubSnapshot = room.onStateSnapshot((clients, initialHype) => {
      setActivePeers(clients);
      setHypeTotal(initialHype);
      for (const client of clients) {
        const p = interp.getOrCreatePeer(
          client.clientId,
          client.name,
          client.color,
          client.cursor?.x ?? 0.5,
          client.cursor?.y ?? 0.5
        );
        if (client.cursor) {
          p.pushSample(client.cursor.x, client.cursor.y, client.cursor.seq);
        }
      }
    });

    // Handle new peer joining
    const unsubJoin = room.onPeerJoin((client) => {
      setActivePeers((prev) => {
        if (prev.some((p) => p.clientId === client.clientId)) return prev;
        return [...prev, client];
      });
      interp.getOrCreatePeer(client.clientId, client.name, client.color);
    });

    // Handle peer disconnect
    const unsubLeave = room.onPeerLeave((leftClientId) => {
      setActivePeers((prev) => prev.filter((p) => p.clientId !== leftClientId));
      interp.removePeer(leftClientId);
    });

    // Handle collaborative hype updates
    const unsubHype = room.onHypeUpdate((totalCount) => {
      setHypeTotal(totalCount);
      // Emit celebratory shockwave from center target
      rendererRef.current?.addReactionBurst('⚡', 0.5, 0.45, '#eab308');
    });

    // Handle live telemetry
    const unsubMetrics = room.onMetrics((m) => {
      setMetrics(m);
    });

    return () => {
      unsubAction();
      unsubSnapshot();
      unsubJoin();
      unsubLeave();
      unsubHype();
      unsubMetrics();
      room.destroy();
    };
  }, [roomId, clientId, name, color]);

  // Set up 60 FPS Canvas rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new CanvasRenderer(canvas);
    rendererRef.current = renderer;

    const handleResize = () => renderer.resize();
    window.addEventListener('resize', handleResize);

    let animationFrameId: number;

    const loop = () => {
      const now = performance.now();
      const smoothedCursors = interpManagerRef.current.updateAll(now);

      renderer.render(
        smoothedCursors,
        localCursorPosRef.current,
        name,
        color
      );

      animationFrameId = requestAnimationFrame(loop);
    };

    animationFrameId = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [name, color]);

  // Handle local pointer movements
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const normX = e.clientX / window.innerWidth;
    const normY = e.clientY / window.innerHeight;

    localCursorPosRef.current = { x: normX, y: normY };

    if (roomRef.current) {
      roomRef.current.sendAction({
        type: 'cursor',
        x: normX,
        y: normY,
      });
    }
  }, []);

  // Trigger reaction at pointer or center
  const emitReaction = useCallback(
    (emoji: string, customX?: number, customY?: number) => {
      const x = customX ?? (localCursorPosRef.current ? localCursorPosRef.current.x : 0.5);
      const y = customY ?? (localCursorPosRef.current ? localCursorPosRef.current.y : 0.5);

      // Local optimistic particle burst
      rendererRef.current?.addReactionBurst(emoji, x, y, color);

      // Dispatch to room
      roomRef.current?.sendAction({
        type: 'reaction',
        emoji,
        x,
        y,
      });
    },
    [color]
  );

  // Trigger collaborative hype tap
  const handleHypeTap = useCallback(() => {
    // Local optimistic reaction
    rendererRef.current?.addReactionBurst('⚡', 0.5, 0.45, '#fbbf24');
    roomRef.current?.sendAction({
      type: 'hype_tap',
    });
  }, []);

  // Keyboard shortcut listener (1-6 for emojis)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = parseInt(e.key, 10);
      if (key >= 1 && key <= REACTION_EMOJIS.length) {
        const item = REACTION_EMOJIS[key - 1];
        setSelectedEmoji(item.emoji);
        emitReaction(item.emoji);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [emitReaction]);

  return (
    <div
      className="relative w-screen h-screen overflow-hidden select-none bg-[#080c14] text-slate-100 font-sans"
      onPointerMove={handlePointerMove}
      onClick={(e) => {
        // If clicking directly on empty stage, burst selected emoji
        if ((e.target as HTMLElement).tagName === 'DIV' || (e.target as HTMLElement).tagName === 'CANVAS') {
          emitReaction(selectedEmoji, e.clientX / window.innerWidth, e.clientY / window.innerHeight);
        }
      }}
    >
      {/* Background Ambient Broadcast Grid */}
      <div
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(255, 255, 255, 0.05) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(255, 255, 255, 0.05) 1px, transparent 1px)
          `,
          backgroundSize: '48px 48px',
        }}
      />
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_800px_at_50%_40%,rgba(99,102,241,0.12),transparent_70%)]" />

      {/* 60 FPS Interactive Canvas Overlay */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-10"
      />

      {/* TOP HEADER BAR */}
      <header className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-auto">
        <div className="flex items-center gap-3 glass-panel px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-rose-500 animate-pulse" />
            <div className="live-badge">
              <span className="live-dot" />
              LIVE FAN STAGE
            </div>
          </div>
          <div className="h-4 w-[1px] bg-slate-700" />
          <div className="flex items-center gap-1.5 text-xs text-slate-300">
            <span className="text-slate-500">Room:</span>
            <input
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.trim() || 'watch-party-42')}
              className="bg-slate-800/80 border border-slate-700 rounded px-2 py-0.5 text-xs font-mono text-indigo-300 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        {/* Presence Counter & User Profile */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPresenceOpen(!presenceOpen)}
            className="glass-panel px-3.5 py-2 flex items-center gap-2 text-xs hover:bg-slate-800/80 transition cursor-pointer"
          >
            <Users className="w-4 h-4 text-indigo-400" />
            <span className="font-semibold text-slate-200">
              {activePeers.length + 1}
            </span>
            <span className="text-slate-400">Viewers</span>
          </button>

          <div className="glass-panel px-3.5 py-2 flex items-center gap-2 text-xs">
            <div
              className="w-3.5 h-3.5 rounded-full border border-white/40 shadow-sm"
              style={{ backgroundColor: color }}
            />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 16))}
              className="bg-transparent text-xs font-medium text-slate-200 w-24 focus:outline-none focus:ring-1 focus:ring-indigo-400 rounded px-1"
              title="Click to rename yourself"
            />
            {metrics.connected ? (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono">
                <Wifi className="w-3.5 h-3.5" />
                {metrics.rttMs}ms
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-rose-400 font-mono">
                <WifiOff className="w-3.5 h-3.5" />
                Connecting...
              </span>
            )}
          </div>
        </div>
      </header>

      {/* CENTER STAGE: Collaborative Fan Hype Widget */}
      <main className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-0">
        <div className="pointer-events-auto flex flex-col items-center text-center p-8 max-w-md w-full glass-panel border border-indigo-500/20 shadow-2xl relative overflow-hidden">
          {/* Subtle glowing banner background */}
          <div className="absolute -top-20 -left-20 w-48 h-48 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-20 -right-20 w-48 h-48 bg-rose-500/10 rounded-full blur-3xl pointer-events-none" />

          <div className="inline-flex items-center gap-1.5 text-xs text-indigo-400 font-semibold uppercase tracking-wider mb-2">
            <Sparkles className="w-3.5 h-3.5" />
            Live Broadcast Fan-Moment
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1">
            Championship World Finals
          </h1>
          <p className="text-xs text-slate-400 mb-6">
            Move your cursor, burst reactions, and collaborate in real-time.
          </p>

          {/* Interactive Hype Button with synchronized state reconciliation */}
          <div className="w-full flex flex-col items-center gap-3">
            <button
              onClick={handleHypeTap}
              className="group relative px-7 py-4 rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 hover:from-amber-400 hover:to-rose-400 text-slate-950 font-black tracking-wide shadow-lg shadow-amber-500/25 active:scale-95 transition-all duration-150 flex items-center gap-3 cursor-pointer"
            >
              <Zap className="w-5 h-5 fill-current text-slate-950 group-hover:scale-110 transition" />
              <span className="text-base uppercase tracking-wider">TAP FAN HYPE</span>
              <span className="bg-slate-950 text-amber-400 font-mono text-sm px-2.5 py-0.5 rounded-full font-bold">
                {hypeTotal.toLocaleString()}
              </span>
            </button>
            <span className="text-[11px] text-slate-400">
              ⚡ Simultaneous taps reconciled server-authoritatively
            </span>
          </div>
        </div>

        {/* Multi-Tab Prompt Hint */}
        <div className="mt-4 px-4 py-1.5 rounded-full bg-slate-900/60 border border-slate-700/50 text-[11px] text-slate-400 pointer-events-auto backdrop-blur-md">
          💡 Open this URL in <span className="text-indigo-400 font-semibold">2–4 browser tabs</span> to see cursors glide live without teleporting!
        </div>
      </main>

      {/* BOTTOM ACTION BAR: Emoji Burst Selector */}
      <footer className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
        <div className="glass-panel px-3 py-2 flex items-center gap-2 border border-slate-700/60 shadow-xl">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider pl-2 pr-1 hidden sm:inline">
            Reactions
          </span>
          <div className="flex items-center gap-1">
            {REACTION_EMOJIS.map((item, idx) => (
              <button
                key={item.emoji}
                onClick={() => {
                  setSelectedEmoji(item.emoji);
                  emitReaction(item.emoji);
                }}
                className={`relative px-3 py-2 rounded-xl text-lg flex items-center justify-center transition-all cursor-pointer ${
                  selectedEmoji === item.emoji
                    ? 'bg-indigo-600/30 border border-indigo-500/60 scale-105 shadow-md shadow-indigo-500/20'
                    : 'hover:bg-slate-800/60 border border-transparent'
                }`}
                title={`Press '${idx + 1}' or tap to burst`}
              >
                <span>{item.emoji}</span>
                <span className="absolute -bottom-1 right-1 text-[9px] font-mono text-slate-500">
                  {idx + 1}
                </span>
              </button>
            ))}
          </div>
        </div>
      </footer>

      {/* FLOATING DIAGNOSTICS & INTERPOLATION CONTROL PANEL */}
      <aside
        className={`absolute top-20 right-4 z-20 transition-all duration-300 pointer-events-auto ${
          panelOpen ? 'w-80' : 'w-12'
        }`}
      >
        <div className="glass-panel border border-slate-700/70 overflow-hidden shadow-2xl">
          {/* Header */}
          <div className="px-4 py-3 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-indigo-400" />
              {panelOpen && (
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Engine & Simulation
                </span>
              )}
            </div>
            <button
              onClick={() => setPanelOpen(!panelOpen)}
              className="text-slate-400 hover:text-white p-1 rounded transition cursor-pointer"
              title={panelOpen ? 'Collapse' : 'Expand'}
            >
              {panelOpen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>

          {panelOpen && (
            <div className="p-4 space-y-4 max-h-[calc(100vh-140px)] overflow-y-auto text-xs">
              {/* Telemetry Metrics */}
              <div>
                <div className="flex items-center gap-1.5 text-slate-400 font-semibold mb-2 uppercase tracking-wider text-[10px]">
                  <Activity className="w-3.5 h-3.5 text-cyan-400" />
                  Live Sync Telemetry
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="glass-card p-2">
                    <span className="text-[10px] text-slate-500 block">Round Trip Time</span>
                    <span className="font-mono text-sm font-bold text-emerald-400">
                      {metrics.rttMs} ms
                    </span>
                  </div>
                  <div className="glass-card p-2">
                    <span className="text-[10px] text-slate-500 block">Network Jitter</span>
                    <span className="font-mono text-sm font-bold text-cyan-400">
                      ±{metrics.jitterMs} ms
                    </span>
                  </div>
                  <div className="glass-card p-2">
                    <span className="text-[10px] text-slate-500 block">Remote Updates/s</span>
                    <span className="font-mono text-sm font-bold text-indigo-400">
                      {metrics.remoteUpdatesPerSec} Hz
                    </span>
                  </div>
                  <div className="glass-card p-2">
                    <span className="text-[10px] text-slate-500 block">Packets In/Out</span>
                    <span className="font-mono text-xs font-bold text-slate-300">
                      {metrics.packetsReceived} / {metrics.packetsSent}
                    </span>
                  </div>
                </div>
              </div>

              {/* Interpolation Strategy */}
              <div>
                <div className="flex items-center gap-1.5 text-slate-400 font-semibold mb-2 uppercase tracking-wider text-[10px]">
                  <Layers className="w-3.5 h-3.5 text-purple-400" />
                  Interpolation Strategy
                </div>
                <div className="space-y-1.5">
                  <label
                    className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition ${
                      interpMode === 'extrapolation'
                        ? 'bg-indigo-950/40 border-indigo-500 text-white'
                        : 'border-slate-800 text-slate-400 hover:bg-slate-800/40'
                    }`}
                  >
                    <div>
                      <span className="font-semibold block text-slate-200">
                        Dead Reckoning (Extrapolation)
                      </span>
                      <span className="text-[10px] text-slate-500">
                        Projects velocity forward; lowest perceived latency [Bonus]
                      </span>
                    </div>
                    <input
                      type="radio"
                      name="interp"
                      checked={interpMode === 'extrapolation'}
                      onChange={() => setInterpMode('extrapolation')}
                    />
                  </label>

                  <label
                    className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition ${
                      interpMode === 'hermite'
                        ? 'bg-indigo-950/40 border-indigo-500 text-white'
                        : 'border-slate-800 text-slate-400 hover:bg-slate-800/40'
                    }`}
                  >
                    <div>
                      <span className="font-semibold block text-slate-200">
                        Catmull-Rom Spline
                      </span>
                      <span className="text-[10px] text-slate-500">
                        C1 continuous smooth curves; eliminates angular kinks
                      </span>
                    </div>
                    <input
                      type="radio"
                      name="interp"
                      checked={interpMode === 'hermite'}
                      onChange={() => setInterpMode('hermite')}
                    />
                  </label>

                  <label
                    className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition ${
                      interpMode === 'lerp'
                        ? 'bg-indigo-950/40 border-indigo-500 text-white'
                        : 'border-slate-800 text-slate-400 hover:bg-slate-800/40'
                    }`}
                  >
                    <div>
                      <span className="font-semibold block text-slate-200">
                        Linear LERP
                      </span>
                      <span className="text-[10px] text-slate-500">
                        Interpolates between enclosing buffered packets
                      </span>
                    </div>
                    <input
                      type="radio"
                      name="interp"
                      checked={interpMode === 'lerp'}
                      onChange={() => setInterpMode('lerp')}
                    />
                  </label>

                  <label
                    className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition ${
                      interpMode === 'raw'
                        ? 'bg-rose-950/40 border-rose-500 text-rose-300'
                        : 'border-slate-800 text-slate-400 hover:bg-slate-800/40'
                    }`}
                  >
                    <div>
                      <span className="font-semibold block text-rose-400">
                        Raw Snapping (No Interpolation)
                      </span>
                      <span className="text-[10px] text-slate-500">
                        Demonstrates raw stutter & teleportation baseline
                      </span>
                    </div>
                    <input
                      type="radio"
                      name="interp"
                      checked={interpMode === 'raw'}
                      onChange={() => setInterpMode('raw')}
                    />
                  </label>
                </div>
              </div>

              {/* Render Buffer Window Slider */}
              <div>
                <div className="flex justify-between text-slate-400 text-[11px] mb-1">
                  <span>Render Delay Buffer:</span>
                  <span className="font-mono text-indigo-400 font-bold">{bufferDelay} ms</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="150"
                  value={bufferDelay}
                  onChange={(e) => setBufferDelay(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-[9px] text-slate-500 mt-0.5">
                  <span>0ms (Snappy/Risk Stutter)</span>
                  <span>150ms (Ultra Smooth)</span>
                </div>
              </div>

              {/* SIMULATED NETWORK DEGRADATION */}
              <div className="pt-2 border-t border-slate-800">
                <div className="flex items-center justify-between text-slate-400 font-semibold mb-2 uppercase tracking-wider text-[10px]">
                  <span className="flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-amber-400" />
                    Network Degradation Simulator
                  </span>
                  {(simLatency > 0 || simJitter > 0 || simLoss > 0) && (
                    <button
                      onClick={() => {
                        setSimLatency(0);
                        setSimJitter(0);
                        setSimLoss(0);
                      }}
                      className="text-[10px] text-rose-400 hover:underline flex items-center gap-0.5"
                    >
                      <RefreshCw className="w-2.5 h-2.5" /> Reset
                    </button>
                  )}
                </div>

                {/* Added Latency */}
                <div className="mb-2">
                  <div className="flex justify-between text-slate-400 text-[11px] mb-1">
                    <span>Simulated Lag:</span>
                    <span className="font-mono text-amber-400 font-bold">+{simLatency} ms</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="350"
                    step="25"
                    value={simLatency}
                    onChange={(e) => setSimLatency(Number(e.target.value))}
                    className="w-full"
                  />
                </div>

                {/* Added Jitter */}
                <div className="mb-2">
                  <div className="flex justify-between text-slate-400 text-[11px] mb-1">
                    <span>Simulated Jitter:</span>
                    <span className="font-mono text-amber-400 font-bold">±{simJitter} ms</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    value={simJitter}
                    onChange={(e) => setSimJitter(Number(e.target.value))}
                    className="w-full"
                  />
                </div>

                {/* Packet Loss */}
                <div>
                  <div className="flex justify-between text-slate-400 text-[11px] mb-1">
                    <span>Simulated Packet Loss:</span>
                    <span className="font-mono text-rose-400 font-bold">{simLoss}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="20"
                    value={simLoss}
                    onChange={(e) => setSimLoss(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>

              {/* Force Reconnect */}
              <div className="pt-2 border-t border-slate-800">
                <button
                  onClick={() => roomRef.current?.reconnect()}
                  className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Simulate Reconnect Cycle
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* PRESENCE MODAL / DRAWER */}
      {presenceOpen && (
        <div className="absolute top-16 right-4 z-30 w-72 glass-panel border border-slate-700 shadow-2xl p-4 pointer-events-auto">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Active Participants ({activePeers.length + 1})
            </h3>
            <button
              onClick={() => setPresenceOpen(false)}
              className="text-slate-400 hover:text-white text-sm cursor-pointer"
            >
              ✕
            </button>
          </div>

          <div className="space-y-2 max-h-60 overflow-y-auto">
            {/* Local Client */}
            <div className="p-2 rounded-lg bg-indigo-950/30 border border-indigo-500/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="font-semibold text-xs text-white">{name}</span>
                <span className="text-[10px] text-indigo-400 font-mono">(You)</span>
              </div>
              <span className="text-[10px] text-emerald-400 font-mono">online</span>
            </div>

            {/* Remote Peers */}
            {activePeers.map((peer) => (
              <div
                key={peer.clientId}
                className="p-2 rounded-lg bg-slate-900/40 border border-slate-800 flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: peer.color }}
                  />
                  <span className="font-medium text-xs text-slate-300">
                    {peer.name}
                  </span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">
                  active
                </span>
              </div>
            ))}
          </div>

          {/* Color Chooser */}
          <div className="mt-4 pt-3 border-t border-slate-800">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-2">
              Your Cursor Color:
            </span>
            <div className="flex gap-1.5">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full transition cursor-pointer ${
                    color === c ? 'ring-2 ring-white scale-110' : 'opacity-80 hover:opacity-100'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
