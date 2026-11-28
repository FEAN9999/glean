// From Magic UI (MIT), https://magicui.design/docs/components/number-ticker
// Changed: numbers go through the app's formatter, and reduced motion shows the value at once.
import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react';
import { useInView, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import { cn } from '../../lib/cn';

interface NumberTickerProps extends ComponentPropsWithoutRef<'span'> {
  value: number;
  format: (n: number) => string;
  startValue?: number;
  delay?: number;
}

export function NumberTicker({ value, format, startValue = 0, delay = 0, className, ...props }: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const motionValue = useMotionValue(startValue);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });
  const isInView = useInView(ref, { once: true, margin: '0px' });

  useEffect(() => {
    if (reduce) {
      if (ref.current) ref.current.textContent = format(value);
      return;
    }
    if (!isInView) return;
    const timer = setTimeout(() => motionValue.set(value), delay * 1000);
    return () => clearTimeout(timer);
  }, [motionValue, isInView, delay, value, reduce, format]);

  useEffect(
    () =>
      springValue.on('change', (latest) => {
        if (ref.current && !reduce) ref.current.textContent = format(Math.round(latest));
      }),
    [springValue, format, reduce],
  );

  return (
    <span ref={ref} className={cn('inline-block tabular-nums', className)} {...props}>
      {format(reduce ? value : startValue)}
    </span>
  );
}
