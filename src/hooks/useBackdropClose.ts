import { useEffect, useRef } from "react";

export function useBackdropClose(isOpen: boolean, onClose?: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen || !onCloseRef.current) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains("pf-v6-c-backdrop")) {
        onCloseRef.current?.();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen]);
}
