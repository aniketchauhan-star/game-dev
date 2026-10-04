import { describe, expect, it } from 'vitest';
import { resolvePartTarget } from '../../../server/src/ingest/pptx.ts';

describe('resolvePartTarget — resolves relationship targets inside the package', () => {
  it.each<[string, string, string]>([
    ['', 'ppt/presentation.xml', 'ppt/presentation.xml'],
    ['ppt/presentation.xml', 'slides/slide10.xml', 'ppt/slides/slide10.xml'],
    ['ppt/slides/slide1.xml', '../media/image1.png', 'ppt/media/image1.png'],
    ['ppt/slides/slide1.xml', '../slideLayouts/slideLayout2.xml', 'ppt/slideLayouts/slideLayout2.xml'],
    ['ppt/slides/slide1.xml', 'sub/./deeper/../x.xml', 'ppt/slides/sub/x.xml'],
    ['ppt/slides/slide1.xml', '/ppt/media/image2.png', 'ppt/media/image2.png'],
    ['ppt/slides/slide1.xml', '../media/image%201.png', 'ppt/media/image 1.png'],
    ['ppt/slides/slide1.xml', '../../docProps/app.xml', 'docProps/app.xml'],
    ['ppt/slides/slide1.xml', '../media/bad%E0%A4%A.png', 'ppt/media/bad%E0%A4%A.png'],
  ])('(%j, %j) → %j', (source, target, expected) => {
    expect(resolvePartTarget(source, target)).toBe(expected);
  });
});

describe('resolvePartTarget — refuses anything that is not a part of this package', () => {
  it.each<[string, string, string]>([
    ['parent escape', 'ppt/slides/slide1.xml', '../../../etc/passwd'],
    ['escape from the root part', '', '../outside.xml'],
    ['absolute escape', 'ppt/slides/slide1.xml', '/../etc/passwd'],
    ['percent-encoded escape', 'ppt/slides/slide1.xml', '%2e%2e/%2e%2e/%2e%2e/etc/passwd'],
    ['percent-encoded slashes', 'ppt/slides/slide1.xml', '..%2F..%2F..%2Fetc%2Fpasswd'],
    ['backslashes', 'ppt/slides/slide1.xml', '..\\..\\..\\Windows\\win.ini'],
    ['an encoded backslash', 'ppt/slides/slide1.xml', '..%5c..%5cevil'],
    ['a NUL byte', 'ppt/slides/slide1.xml', '../media/a.png\0.xml'],
    ['an encoded NUL byte', 'ppt/slides/slide1.xml', '../media/a.png%00.xml'],
    ['a file: URL', 'ppt/slides/slide1.xml', 'file:///etc/passwd'],
    ['an http URL', 'ppt/slides/slide1.xml', 'http://example.invalid/image.png'],
    ['an https URL', 'ppt/slides/slide1.xml', 'HTTPS://example.invalid/x'],
    ['a UNC-style path', 'ppt/slides/slide1.xml', '//server/share/x.png'],
    ['a drive letter', 'ppt/slides/slide1.xml', 'C:/Windows/win.ini'],
    ['a javascript: URL', 'ppt/slides/slide1.xml', 'javascript:alert(1)'],
    ['the package root itself', 'ppt/slides/slide1.xml', '../..'],
  ])('rejects %s', (_label, source, target) => {
    expect(resolvePartTarget(source, target)).toBeNull();
  });
});
