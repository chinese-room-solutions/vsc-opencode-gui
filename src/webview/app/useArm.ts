import { useEffect, useRef, useState } from "preact/hooks";

// Two-click destructive-action arming: first call arms (the button turns
// red "Confirm Deletion"), the caller commits on the second click, and the
// state resets itself after `ms` so a stray first click can't linger.
export function useArm(
  ms = 2000,
): [boolean, () => void, () => void] {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const arm = () => {
    setArmed(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), ms);
  };
  const disarm = () => {
    setArmed(false);
    clearTimeout(timer.current);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return [armed, arm, disarm];
}
