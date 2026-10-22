//go:build darwin

package tray

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// systray не даёт задать шрифт заголовка и не показывает значки пунктов в меню строки состояния,
// поэтому дорабатываем его объекты через публичный AppKit.

static NSImage *indicatorImage;
static NSMenu *trayMenu;
static BOOL decorating;

static NSStatusBarButton *findButton(NSView *view) {
  if ([view isKindOfClass:[NSStatusBarButton class]]) return (NSStatusBarButton *)view;
  for (NSView *sub in view.subviews) {
    NSStatusBarButton *found = findButton(sub);
    if (found) return found;
  }
  return nil;
}

static void monospaceTitle(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    for (NSWindow *window in NSApp.windows) {
      NSStatusBarButton *button = findButton(window.contentView);
      if (button) {
        button.font = [NSFont monospacedDigitSystemFontOfSize:[NSFont menuBarFontOfSize:0].pointSize weight:NSFontWeightRegular];
      }
    }
  });
}

static void decorate(NSMenuItem *item) {
  if (decorating) return;
  // После SetTitle от systray старый attributedTitle может остаться, поэтому смотрим на сам текст.
  NSString *text = item.title;
  NSString *prefix = [NSString stringWithFormat:@"%C  ", (unichar)NSAttachmentCharacter];
  if ([text hasPrefix:prefix]) text = [text substringFromIndex:prefix.length];
  decorating = YES;
  if (indicatorImage == nil) {
    item.title = text;
  } else {
    NSFont *font = [NSFont menuFontOfSize:0];
    CGFloat size = round(font.capHeight + 1);
    NSTextAttachment *attachment = [[NSTextAttachment alloc] init];
    attachment.image = indicatorImage;
    attachment.bounds = NSMakeRect(0, round((font.capHeight - size) / 2), size, size);
    NSMutableAttributedString *title = [[NSMutableAttributedString alloc] initWithAttributedString:[NSAttributedString attributedStringWithAttachment:attachment]];
    NSColor *color = item.enabled ? [NSColor labelColor] : [NSColor disabledControlTextColor];
    [title appendAttributedString:[[NSAttributedString alloc] initWithString:[@"  " stringByAppendingString:text] attributes:@{NSFontAttributeName : font, NSForegroundColorAttributeName : color}]];
    item.attributedTitle = title;
  }
  decorating = NO;
}

static void decorateFirst(void) {
  if (trayMenu != nil && trayMenu.numberOfItems > 0) decorate([trayMenu itemAtIndex:0]);
}

static void watchMenu(const void *png, int length) {
  indicatorImage = length > 0 ? [[NSImage alloc] initWithData:[NSData dataWithBytes:png length:length]] : nil;
  void (^handler)(NSNotification *) = ^(NSNotification *note) {
    NSMenu *menu = note.object;
    if (menu.supermenu != nil || menu == NSApp.mainMenu) return;
    if ([note.userInfo[@"NSMenuItemIndex"] integerValue] != 0) return;
    trayMenu = menu;
    decorateFirst();
  };
  [[NSNotificationCenter defaultCenter] addObserverForName:NSMenuDidAddItemNotification object:nil queue:nil usingBlock:handler];
  [[NSNotificationCenter defaultCenter] addObserverForName:NSMenuDidChangeItemNotification object:nil queue:nil usingBlock:handler];
}

static void setIndicator(const void *png, int length) {
  NSImage *image = length > 0 ? [[NSImage alloc] initWithData:[NSData dataWithBytes:png length:length]] : nil;
  dispatch_async(dispatch_get_main_queue(), ^{
    indicatorImage = image;
    decorateFirst();
  });
}
*/
import "C"

import (
	"os/exec"
	"unsafe"

	"fyne.io/systray"
)

// prepare вызывается до первого пункта меню: точка встраивается в статус при его добавлении.
func prepare(indicator []byte) {
	C.watchMenu(bytesPointer(indicator), C.int(len(indicator)))
	C.monospaceTitle()
}

func setIndicator(_ *systray.MenuItem, icon []byte) {
	C.setIndicator(bytesPointer(icon), C.int(len(icon)))
}

func bytesPointer(data []byte) unsafe.Pointer {
	if len(data) == 0 {
		return nil
	}
	return unsafe.Pointer(&data[0])
}

func openCommand(target string, folder bool) *exec.Cmd {
	if folder {
		return exec.Command("/usr/bin/open", "-a", "Finder", target)
	}
	return exec.Command("/usr/bin/open", target)
}
