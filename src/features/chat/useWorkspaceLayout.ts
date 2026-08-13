import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 20;
const FONT_SIZE_DEFAULT = 12;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 520;
const SIDEBAR_WIDTH_DEFAULT = 216;
const MAP_WIDTH_MIN = 180;
const MAP_WIDTH_MAX = 520;
const MAP_WIDTH_DEFAULT = 250;

const clampFontSize = (value: number) => (
  Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(value)))
);

const clampPanelWidth = (value: number, min: number, max: number) => (
  Math.max(min, Math.min(max, Math.round(value)))
);

const loadStoredPanelWidth = (key: string, fallback: number, min: number, max: number) => {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) ? clampPanelWidth(value, min, max) : fallback;
};

type ActiveResizer = 'sidebar' | 'map' | null;

export function useWorkspaceLayout() {
  const [fontSize, setFontSizeValue] = useState(() => {
    const value = Number(localStorage.getItem('fontSize'));
    return Number.isFinite(value) ? clampFontSize(value) : FONT_SIZE_DEFAULT;
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => (
    loadStoredPanelWidth('sidebarWidth', SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
  ));
  const [mapPanelWidth, setMapPanelWidth] = useState(() => (
    loadStoredPanelWidth('mapPanelWidth', MAP_WIDTH_DEFAULT, MAP_WIDTH_MIN, MAP_WIDTH_MAX)
  ));
  const [chatWidth, setChatWidth] = useState(() => Number(localStorage.getItem('chatWidth')) || 800);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => localStorage.getItem('sidebarOpen') !== '0');
  const [isMessageMapOpen, setIsMessageMapOpen] = useState(() => localStorage.getItem('messageMapOpen') !== '0');
  const [activeResizer, setActiveResizer] = useState<ActiveResizer>(null);
  const resizeRef = useRef<{ type: Exclude<ActiveResizer, null>; startX: number; startWidth: number } | null>(null);

  const setFontSize = useCallback((value: number) => {
    setFontSizeValue(clampFontSize(value));
  }, []);

  const adjustFontSize = useCallback((delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    setFontSizeValue((current) => clampFontSize(current + delta));
  }, []);

  const handleSidebarResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = { type: 'sidebar', startX: event.clientX, startWidth: sidebarWidth };
    setActiveResizer('sidebar');
  }, [sidebarWidth]);

  const handleMapResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = { type: 'map', startX: event.clientX, startWidth: mapPanelWidth };
    setActiveResizer('map');
  }, [mapPanelWidth]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen((open) => {
      if (open && activeResizer === 'sidebar') {
        resizeRef.current = null;
        setActiveResizer(null);
      }
      return !open;
    });
  }, [activeResizer]);

  useEffect(() => {
    localStorage.setItem('fontSize', String(fontSize));
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}pt`);
  }, [fontSize]);

  useEffect(() => {
    localStorage.setItem('sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem('sidebarOpen', isSidebarOpen ? '1' : '0');
  }, [isSidebarOpen]);

  useEffect(() => {
    localStorage.setItem('mapPanelWidth', String(mapPanelWidth));
  }, [mapPanelWidth]);

  useEffect(() => {
    localStorage.setItem('messageMapOpen', isMessageMapOpen ? '1' : '0');
  }, [isMessageMapOpen]);

  useEffect(() => {
    localStorage.setItem('chatWidth', String(chatWidth));
    document.documentElement.style.setProperty('--message-max-width', `${chatWidth}px`);
  }, [chatWidth]);

  useEffect(() => {
    if (!activeResizer) return;
    const handleMouseMove = (event: MouseEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const deltaX = event.clientX - resize.startX;
      if (resize.type === 'sidebar') {
        setSidebarWidth(clampPanelWidth(resize.startWidth + deltaX, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
      } else {
        setMapPanelWidth(clampPanelWidth(resize.startWidth - deltaX, MAP_WIDTH_MIN, MAP_WIDTH_MAX));
      }
    };
    const handleMouseUp = () => {
      resizeRef.current = null;
      setActiveResizer(null);
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [activeResizer]);

  useEffect(() => {
    const hasModifier = (event: KeyboardEvent | WheelEvent) => event.ctrlKey || event.metaKey;
    const handleWheel = (event: WheelEvent) => {
      if (!hasModifier(event) || event.deltaY === 0) return;
      event.preventDefault();
      adjustFontSize(event.deltaY < 0 ? 1 : -1);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (!hasModifier(event)) return;
      if (event.key === '=' || event.key === '+' || event.key === 'Add') {
        event.preventDefault();
        adjustFontSize(1);
      } else if (event.key === '-' || event.key === '_' || event.key === 'Subtract') {
        event.preventDefault();
        adjustFontSize(-1);
      } else if (event.key === '0') {
        event.preventDefault();
        setFontSizeValue(FONT_SIZE_DEFAULT);
      }
    };
    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('wheel', handleWheel as EventListener);
      window.removeEventListener('keydown', handleKey);
    };
  }, [adjustFontSize]);

  const containerStyle = useMemo(() => ({
    '--sidebar-width': `${sidebarWidth}px`,
    '--content-nav-width': `${mapPanelWidth}px`,
  } as CSSProperties & Record<'--sidebar-width' | '--content-nav-width', string>), [mapPanelWidth, sidebarWidth]);

  return {
    activeResizer,
    chatWidth,
    containerStyle,
    fontSize,
    handleMapResizeStart,
    handleSidebarResizeStart,
    isMessageMapOpen,
    isSidebarOpen,
    setChatWidth,
    setFontSize,
    setIsMessageMapOpen,
    toggleSidebar,
  };
}
