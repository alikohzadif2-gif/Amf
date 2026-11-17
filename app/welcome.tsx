import { Feather } from '@expo/vector-icons';
import { BlurTargetView, BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, type ReactNode } from 'react';
import { Animated, FlatList, StatusBar, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Button } from '@/components/server/ui';
import { radii } from '@/constants/theme';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { toDigits } from '@/src/lib/calendar';
import { alignOf, rowOf } from '@/src/lib/layout';
import { WELCOME_SLIDES, slideIndex, type WelcomeSlideId } from '@/src/lib/welcome';
import { useSettingsStore } from '@/src/state/settings-store';

/**
 * Welcome carousel (first run only, no account): 4 gradient slides, glass card with a mini preview,
 * animated pill indicator, ONE "Get started" button. Gated by `onboarded` in app/_layout.tsx (Stack.Protected).
 * Reference: docs/zeydi-ui/01–04. No account buttons are built (no sign-up, no sign-in).
 */
const NAVY = '#040B15';
const WHITE = '#FFFFFF';
const CORAL = '#FF6B6B';
const SHADOW = { textShadowColor: 'rgba(0,0,0,0.28)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 } as const;

const COPY: Record<WelcomeSlideId, { title: TranslationKey; text: TranslationKey }> = {
  status: { title: 'welcomeS1Title', text: 'welcomeS1Text' },
  events: { title: 'welcomeS2Title', text: 'welcomeS2Text' },
  diary: { title: 'welcomeS3Title', text: 'welcomeS3Text' },
  gallery: { title: 'welcomeS4Title', text: 'welcomeS4Text' },
};

function Pill({ children }: { children: ReactNode }) {
  return <View style={styles.pill}>{children}</View>;
}

function Preview({ id }: { id: WelcomeSlideId }) {
  const { language, isRTL, t } = useI18n();
  const digits = useSettingsStore((s) => s.digits);
  const row = rowOf(isRTL);
  if (id === 'status') {
    return (
      <Pill>
        <View style={{ flexDirection: row, gap: 8 }}>
          {['😊', '😌', '🤩', '🙂', '😴'].map((e, i) => (
            <View key={e} style={[styles.moodTile, i === 2 ? { backgroundColor: CORAL } : null]}>
              <Text style={{ fontSize: 22 }}>{e}</Text>
            </View>
          ))}
        </View>
      </Pill>
    );
  }
  if (id === 'events') {
    return (
      <Pill>
        <View style={{ flexDirection: row, alignItems: 'center', gap: 12 }}>
          <View style={[styles.round, { backgroundColor: 'rgba(255,255,255,0.35)' }]}>
            <Feather name="calendar" size={22} color={WHITE} />
          </View>
          <View>
            <Text style={[styles.pillTitle, { fontFamily: fontFamilyFor(language, 'semibold'), textAlign: alignOf(isRTL) }]}>{t('welcomePrevNext')}</Text>
            <Text style={[styles.pillSub, { fontFamily: fontFamilyFor(language, 'bold'), textAlign: alignOf(isRTL) }]}>
              {toDigits(12, digits)} {t('welcomePrevDays')}
            </Text>
          </View>
        </View>
      </Pill>
    );
  }
  if (id === 'diary') {
    return (
      <Pill>
        <View style={{ flexDirection: row, alignItems: 'center', gap: 12 }}>
          <View style={[styles.round, { backgroundColor: 'rgba(255,255,255,0.3)' }]}>
            <Feather name="book-open" size={22} color={WHITE} />
          </View>
          <View>
            <Text style={[styles.pillTitle, { fontFamily: fontFamilyFor(language, 'semibold'), textAlign: alignOf(isRTL) }]}>{t('welcomePrevToday')}</Text>
            <Text style={[styles.pillSub, { fontFamily: fontFamilyFor(language, 'medium'), textAlign: alignOf(isRTL) }]}>{t('welcomePrevPrivate')}</Text>
          </View>
        </View>
      </Pill>
    );
  }
  return (
    <Pill>
      <View style={{ flexDirection: row, gap: 8 }}>
        {(['image', 'camera', 'image'] as const).map((icon, i) => (
          <View key={i} style={[styles.photoTile, { backgroundColor: `rgba(255,255,255,${0.18 + i * 0.06})` }]}>
            <Feather name={icon} size={22} color={WHITE} />
          </View>
        ))}
      </View>
    </Pill>
  );
}

export default function WelcomeScreen() {
  const { language, isRTL, t } = useI18n();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const router = useRouter();
  const blurTarget = useRef<View>(null);
  const count = WELCOME_SLIDES.length;
  const scrollX = useRef(new Animated.Value(isRTL ? (count - 1) * width : 0)).current;

  // visual order of the list (reversed in RTL so slide 1 sits at the right)
  const data = WELCOME_SLIDES.map((_, v) => WELCOME_SLIDES[slideIndex(v, count, isRTL)]);
  const visualOf = (logical: number) => slideIndex(logical, count, isRTL);
  const range = (v: number) => [(v - 1) * width, v * width, (v + 1) * width];

  return (
    <View style={[styles.root, { backgroundColor: NAVY }]}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      <BlurTargetView ref={blurTarget} style={StyleSheet.absoluteFill}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: NAVY }]} />
        {WELCOME_SLIDES.map((slide, l) => (
          <Animated.View
            key={slide.id}
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { opacity: scrollX.interpolate({ inputRange: range(visualOf(l)), outputRange: [0, 1, 0], extrapolate: 'clamp' }) }]}
          >
            <LinearGradient colors={[slide.color, slide.color, '#1B2A44', NAVY]} locations={[0, 0.35, 0.8, 1]} style={StyleSheet.absoluteFill} />
          </Animated.View>
        ))}
        <Svg width={width} height={height} viewBox="0 0 100 200" preserveAspectRatio="none" style={StyleSheet.absoluteFill} pointerEvents="none">
          <Path d="M0 82 C 25 62, 55 96, 100 70 L100 200 L0 200 Z" fill="#FFFFFF" fillOpacity={0.1} />
          <Path d="M0 118 C 30 100, 62 136, 100 108 L100 200 L0 200 Z" fill="#000000" fillOpacity={0.14} />
        </Svg>
      </BlurTargetView>

      <View style={{ flex: 1, direction: isRTL ? 'rtl' : 'ltr', paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }}>
        <View style={[styles.header, { flexDirection: rowOf(isRTL) }]}>
          <Image source={require('@/assets/images/icon.png')} style={styles.logo} contentFit="cover" accessibilityLabel={t('brand')} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.brand, SHADOW, { fontFamily: fontFamilyFor(language, 'bold'), textAlign: alignOf(isRTL) }]}>{t('brand')}</Text>
            <Text style={[styles.tagline, SHADOW, { fontFamily: fontFamilyFor(language), textAlign: alignOf(isRTL) }]}>{t('welcomeTagline')}</Text>
          </View>
        </View>

        <View style={{ flex: 1 }} />

        <Animated.FlatList
          data={data}
          keyExtractor={(s) => s.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, direction: 'ltr' }}
          contentContainerStyle={{ direction: 'ltr' }}
          initialScrollIndex={isRTL ? count - 1 : 0}
          getItemLayout={(_d, index) => ({ length: width, offset: width * index, index })}
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: false })}
          scrollEventThrottle={16}
          renderItem={({ item }) => (
            <View style={{ width, paddingHorizontal: 24 }}>
              <View style={styles.card}>
                <BlurView blurTarget={blurTarget} blurMethod="dimezisBlurView" intensity={45} tint="light" style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,255,255,0.16)' }]} />
                <View style={styles.cardBody}>
                  <Preview id={item.id} />
                  <Text accessibilityRole="header" style={[styles.title, SHADOW, { fontFamily: fontFamilyFor(language, 'bold') }]}>{t(COPY[item.id].title)}</Text>
                  <Text style={[styles.text, SHADOW, { fontFamily: fontFamilyFor(language) }]}>{t(COPY[item.id].text)}</Text>
                </View>
              </View>
            </View>
          )}
        />

        <View style={[styles.dots, { flexDirection: rowOf(isRTL) }]}>
          {WELCOME_SLIDES.map((slide, l) => {
            const v = visualOf(l);
            return (
              <Animated.View
                key={slide.id}
                style={[
                  styles.dot,
                  {
                    width: scrollX.interpolate({ inputRange: range(v), outputRange: [8, 36, 8], extrapolate: 'clamp' }),
                    opacity: scrollX.interpolate({ inputRange: range(v), outputRange: [0.5, 1, 0.5], extrapolate: 'clamp' }),
                  },
                ]}
              />
            );
          })}
        </View>

        <View style={{ flex: 1.2 }} />

        <View style={{ paddingHorizontal: 20 }}>
          <Button title="welcomeStart" variant="dark" onPress={() => router.push('/onboarding/name')} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { alignItems: 'center', gap: 14, paddingHorizontal: 24 },
  logo: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#F5F5F0' },
  brand: { color: WHITE, fontSize: 30 },
  tagline: { color: 'rgba(255,255,255,0.92)', fontSize: 15, lineHeight: 24, marginTop: 2 },
  card: { borderRadius: radii.glass, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)', minHeight: 230, justifyContent: 'center' },
  cardBody: { alignItems: 'center', paddingHorizontal: 22, paddingVertical: 24, gap: 12 },
  title: { color: WHITE, fontSize: 22, textAlign: 'center', marginTop: 6 },
  text: { color: 'rgba(255,255,255,0.95)', fontSize: 15.5, lineHeight: 25, textAlign: 'center' },
  pill: { backgroundColor: 'rgba(255,255,255,0.2)', borderColor: 'rgba(255,255,255,0.35)', borderWidth: 1, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 12 },
  pillTitle: { color: WHITE, fontSize: 15 },
  pillSub: { color: 'rgba(255,255,255,0.9)', fontSize: 14, marginTop: 2 },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  moodTile: { width: 46, height: 46, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.28)', alignItems: 'center', justifyContent: 'center' },
  photoTile: { width: 54, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  dots: { alignSelf: 'center', alignItems: 'center', gap: 8, marginTop: 20 },
  dot: { height: 8, borderRadius: 4, backgroundColor: WHITE },
});
