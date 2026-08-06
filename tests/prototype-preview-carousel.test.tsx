import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { prototypeViewportPresets } from '../src/shared/prototype-canvas';
import { PrototypePreviewCarousel } from '../apps/prototype/src/prototype-preview-carousel';

describe('prototype preview canvas', () => {
  test('renders one current prototype without the legacy state chooser', () => {
    const html = renderToStaticMarkup(
      <PrototypePreviewCarousel
        fullscreen={false}
        isRotating={false}
        isSwitchingViewport={false}
        orientation="portrait"
        showDeviceFrame
        viewport={prototypeViewportPresets.phone}
      >
        <p>Prototype fixture</p>
      </PrototypePreviewCarousel>
    );

    expect(html).toContain('data-testid="preview-carousel"');
    expect(html).toContain('aria-label="Current prototype"');
    expect(html).not.toContain('Choose preview');
    expect(html).not.toContain('prototype-preview-carousel__dot');
    expect(html).toContain('Prototype fixture');
  });
});
