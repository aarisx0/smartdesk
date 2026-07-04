import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';

interface StatCardProps {
  label: string;
  value: number | string;
  icon: LucideIcon;
  trend: string;
  color: string;
}

export default function StatCard({ label, value, icon: Icon, trend, color }: StatCardProps) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className="glass-card p-5"
    >
      <div className="flex items-start justify-between mb-4">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{
            background: `${color}20`,
            border: `1px solid ${color}40`,
          }}
        >
          <Icon size={18} style={{ color }} />
        </div>
        <span className="text-xs font-medium px-2 py-0.5 rounded-full"
          style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}>
          {trend}
        </span>
      </div>

      <p className="stat-number text-3xl font-bold">{value}</p>
      <p className="text-xs mt-1" style={{ color: '#8B8BAD' }}>{label}</p>
    </motion.div>
  );
}
