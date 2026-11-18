import 'expo-router/entry';
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import { widgetTaskHandler } from '@/src/widget/task-handler';

// Android calls this when the "days together" widget is added or updated (library docs: Expo + Expo Router).
registerWidgetTaskHandler(widgetTaskHandler);
