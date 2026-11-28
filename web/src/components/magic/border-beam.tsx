// From Magic UI (MIT), https://magicui.design/docs/components/border-beam
// Changed: trimmed to the props in use; hidden under reduced motion.
import { motion, useReducedMotion, type MotionStyle } from 'motion/react';
import type { CSSProperties } from 'react';

interface BorderBeamProps {
  size?: number;
  duration?: number;
  colorFrom?: string;
  colorTo?: string;
  borderWidth?: number;
}

export function BorderBeam({ size = 50, duration = 6, colorFrom = '#ffaa40', colorTo = '#9c40ff', borderWidth = 1 }: BorderBeamProps) {
  if (useReducedMotion()) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-[inherit] border-(length:--border-beam-width) border-transparent mask-[linear-gradient(transparent,transparent),linear-gradient(#000,#000)] mask-intersect [mask-clip:padding-box,border-box]"
      style={{ '--border-beam-width': `${borderWidth}px` } as CSSProperties}
    >
      <motion.div
        className="absolute aspect-square bg-linear-to-l from-(--color-from) via-(--color-to) to-transparent"
        style={
          {
            width: size,
            offsetPath: `rect(0 auto auto 0 round ${size}px)`,
            '--color-from': colorFrom,
            '--color-to': colorTo,
          } as MotionStyle
        }
        initial={{ offsetDistance: '0%' }}
        animate={{ offsetDistance: ['0%', '100%'] }}
        transition={{ repeat: Infinity, ease: 'linear', duration }}
      />
    </div>
  );
}
