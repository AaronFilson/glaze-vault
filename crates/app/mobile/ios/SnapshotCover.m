// Covers the app while it is not active, so the picture iOS keeps for the app switcher shows no
// recipe (docs/adr/0027-phones.md). Loaded with the app; nothing calls it.
#import <UIKit/UIKit.h>

@interface GVSnapshotCover : NSObject
@end

@implementation GVSnapshotCover

static UIView *cover;

+ (void)load {
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserverForName:UIApplicationWillResignActiveNotification
                      object:nil
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(NSNotification *note) {
                    [GVSnapshotCover show];
                  }];
  [center addObserverForName:UIApplicationDidBecomeActiveNotification
                      object:nil
                       queue:NSOperationQueue.mainQueue
                  usingBlock:^(NSNotification *note) {
                    [GVSnapshotCover hide];
                  }];
}

+ (UIWindow *)window {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.isKeyWindow) return window;
    }
  }
  return nil;
}

+ (void)show {
  UIWindow *window = [self window];
  if (window == nil || cover != nil) return;
  cover = [[UIView alloc] initWithFrame:window.bounds];
  cover.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  cover.backgroundColor = UIColor.systemBackgroundColor;
  UILabel *name = [[UILabel alloc] initWithFrame:cover.bounds];
  name.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  name.text = @"Glaze Vault";
  name.textAlignment = NSTextAlignmentCenter;
  name.textColor = UIColor.secondaryLabelColor;
  name.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle2];
  [cover addSubview:name];
  [window addSubview:cover];
}

+ (void)hide {
  [cover removeFromSuperview];
  cover = nil;
}

@end
