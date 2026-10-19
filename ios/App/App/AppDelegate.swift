import UIKit
import Capacitor

// App-local bridge registration avoids any third-party dynamic-icon plugin.
class ForwardXBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ForwardXAppIconPlugin())
    }
}

@objc(ForwardXAppIconPlugin)
class ForwardXAppIconPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "ForwardXAppIconPlugin"
    let jsName = "ForwardXAppIcon"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "setIcon", returnType: CAPPluginReturnPromise)]

    @objc func setIcon(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing app icon theme")
            return
        }
        let parts = key.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2,
              ["ink", "teal", "forest", "wisteria", "ember", "sakura"].contains(parts[0]),
              ["light", "dark"].contains(parts[1]) else {
            call.reject("Unknown app icon theme")
            return
        }
        let name: String? = key == "ink-light" ? nil : "AppIcon" + parts.map { $0.prefix(1).uppercased() + String($0.dropFirst()) }.joined()
        DispatchQueue.main.async {
            let app = UIApplication.shared
            guard app.applicationState == .active, app.supportsAlternateIcons else {
                // The web layer retries when the app returns to the foreground.
                call.resolve(["applied": false])
                return
            }
            guard app.alternateIconName != name else {
                call.resolve(["applied": true])
                return
            }
            if let alternate = name {
                let info = Bundle.main.infoDictionary ?? [:]
                let icons = info["CFBundleIcons"] as? [String: Any] ?? [:]
                let tabletIcons = info["CFBundleIcons~ipad"] as? [String: Any] ?? [:]
                let alternatives = (UIDevice.current.userInterfaceIdiom == .pad ? tabletIcons["CFBundleAlternateIcons"] as? [String: Any] : nil)
                    ?? (icons["CFBundleAlternateIcons"] as? [String: Any]) ?? [:]
                guard alternatives[alternate] != nil else {
                    call.reject("Theme icon is missing from this application bundle")
                    return
                }
            }
            // Use only the public API. iOS may display its icon-change confirmation.
            app.setAlternateIconName(name) { error in
                if let error = error {
                    call.reject("Unable to update app icon: " + error.localizedDescription)
                } else {
                    call.resolve(["applied": true])
                }
            }
        }
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
