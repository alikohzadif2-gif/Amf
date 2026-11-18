import { Stack } from 'expo-router';
import { useColors } from '@/hooks/useColors';

/** The four first-run steps (name, gender, birthday, photo). Reachable only while `onboarded` is false (see app/_layout.tsx). */
export default function OnboardingLayout() {
  const colors = useColors();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: 'slide_from_right' }} />;
}
