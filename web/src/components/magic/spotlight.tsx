// From Aceternity UI (spotlight-new), https://ui.aceternity.com/components/spotlight
// Changed: trimmed to the props in use; the default beams are the night hero's violet. Its sway is a transform, so MotionConfig reducedMotion="user" stops it.
import { motion } from 'motion/react';

const glow = (a: number) => `hsla(252, 100%, 82%, ${a})`;

interface SpotlightProps {
  gradientFirst?: string;
  gradientSecond?: string;
  gradientThird?: string;
  translateY?: number;
  width?: number;
  height?: number;
  smallWidth?: number;
  duration?: number;
  xOffset?: number;
}

export function Spotlight({
  gradientFirst = `radial-gradient(68.54% 68.72% at 55.02% 31.46%, ${glow(0.14)} 0, ${glow(0.04)} 50%, transparent 80%)`,
  gradientSecond = `radial-gradient(50% 50% at 50% 50%, ${glow(0.1)} 0, ${glow(0.03)} 80%, transparent 100%)`,
  gradientThird = `radial-gradient(50% 50% at 50% 50%, ${glow(0.07)} 0, ${glow(0.02)} 80%, transparent 100%)`,
  translateY = -350, width = 560, height = 1380, smallWidth = 240, duration = 7, xOffset = 100 }: SpotlightProps) {
  const sway = { duration, repeat: Infinity, repeatType: 'reverse' as const, ease: 'easeInOut' as const };
  return (
    <motion.div aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.5 }} className="pointer-events-none absolute inset-0 h-full w-full">
      <motion.div animate={{ x: [0, xOffset, 0] }} transition={sway} className="pointer-events-none absolute top-0 left-0 h-screen w-screen">
        <div style={{ transform: `translateY(${translateY}px) rotate(-45deg)`, background: gradientFirst, width, height }} className="absolute top-0 left-0" />
        <div style={{ transform: 'rotate(-45deg) translate(5%, -50%)', background: gradientSecond, width: smallWidth, height }} className="absolute top-0 left-0 origin-top-left" />
        <div style={{ transform: 'rotate(-45deg) translate(-180%, -70%)', background: gradientThird, width: smallWidth, height }} className="absolute top-0 left-0 origin-top-left" />
      </motion.div>
      <motion.div animate={{ x: [0, -xOffset, 0] }} transition={sway} className="pointer-events-none absolute top-0 right-0 h-screen w-screen">
        <div style={{ transform: `translateY(${translateY}px) rotate(45deg)`, background: gradientFirst, width, height }} className="absolute top-0 right-0" />
        <div style={{ transform: 'rotate(45deg) translate(-5%, -50%)', background: gradientSecond, width: smallWidth, height }} className="absolute top-0 right-0 origin-top-right" />
        <div style={{ transform: 'rotate(45deg) translate(180%, -70%)', background: gradientThird, width: smallWidth, height }} className="absolute top-0 right-0 origin-top-right" />
      </motion.div>
    </motion.div>
  );
}
