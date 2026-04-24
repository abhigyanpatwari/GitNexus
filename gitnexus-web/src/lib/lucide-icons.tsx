/**
 * Centralized icon re-exports from lucide-react.
 *
 * All components import icons from this module (@/lib/lucide-icons) rather
 * than directly from lucide-react. This provides a single place to manage
 * which icons are used and allows future optimization (e.g., tree-shaking
 * configuration, icon subset bundling) without touching every component.
 *
 * Note on `Github`: brand icons were removed in lucide-react v1
 * (https://lucide.dev/guide/react/migration). We provide a local
 * SVG component below that mirrors the lucide v0 mark and the lucide
 * component API, so consumers can keep importing it from this module.
 */
import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

export {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  AtSign,
  Brain,
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code,
  Copy,
  Eye,
  EyeOff,
  FileArchive,
  FileCode,
  Filter,
  FlaskConical,
  Focus,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  Hash,
  Heart,
  HelpCircle,
  Home,
  Key,
  Layers,
  Lightbulb,
  LightbulbOff,
  List,
  Loader2,
  Maximize2,
  MousePointerClick,
  PanelLeft,
  PanelLeftClose,
  PanelRightClose,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Send,
  Server,
  Settings,
  SkipForward,
  Snail,
  Sparkles,
  Square,
  Star,
  Table,
  Target,
  Terminal,
  Trash2,
  Type,
  Upload,
  User,
  Variable,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

export const Github = forwardRef<SVGSVGElement, LucideProps>(function Github(
  { size = 24, color = 'currentColor', strokeWidth = 2, absoluteStrokeWidth, className, ...rest },
  ref,
) {
  const resolvedStrokeWidth = absoluteStrokeWidth
    ? (Number(strokeWidth) * 24) / Number(size)
    : strokeWidth;
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={resolvedStrokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
});
