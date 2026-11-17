import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';
import { KeyboardEvents } from 'react-native-keyboard-controller';

/**
 * The height of the on-screen keyboard (0 when it is closed), for screens that lift a bottom bar above it.
 * The app runs edge-to-edge under `KeyboardProvider`: there the plain React Native keyboard events can stay silent, so the
 * keyboard-controller events are the main source; the React Native ones are only a fallback until the first of those arrives.
 * No worklets or animated views are involved (those crashed on popped screens, see app/diary/new.tsx).
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    let controllerSeen = false;
    const apply = (value: number | undefined) => setHeight(Math.max(0, Math.round(value ?? 0)));
    const subs = [
      KeyboardEvents.addListener('keyboardDidShow', (event) => { controllerSeen = true; apply(event.height); }),
      KeyboardEvents.addListener('keyboardDidHide', () => { controllerSeen = true; apply(0); }),
      Keyboard.addListener('keyboardDidShow', (event) => { if (!controllerSeen) apply(event.endCoordinates?.height); }),
      Keyboard.addListener('keyboardDidHide', () => { if (!controllerSeen) apply(0); }),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);
  return height;
}
