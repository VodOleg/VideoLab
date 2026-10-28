import w700 from '@fontsource/montserrat/files/montserrat-latin-700-normal.woff2';
import w800 from '@fontsource/montserrat/files/montserrat-latin-800-normal.woff2';
import w900 from '@fontsource/montserrat/files/montserrat-latin-900-normal.woff2';
import { loadFont } from '../engine/index.ts';

export const fontFamily = loadFont('Montserrat', { 700: w700, 800: w800, 900: w900 });
