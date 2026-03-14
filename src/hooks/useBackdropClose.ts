import { useEffect } from "react";

export function useBackdropClose(isOpen: boolean, onClose?: () => void) {
  useEffect(() => {
    if (!isOpen || !onClose) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[role="dialog"]')) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, onClose]);
}
