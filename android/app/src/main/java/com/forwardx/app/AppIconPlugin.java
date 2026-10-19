package com.forwardx.app;

import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

@CapacitorPlugin(name = "ForwardXAppIcon")
public class AppIconPlugin extends Plugin {
    private static final List<String> THEMES = Arrays.asList("ink", "teal", "forest", "wisteria", "ember", "sakura");

    private ComponentName component(String theme, String mode) {
        return new ComponentName(getContext(), getContext().getPackageName() + ".Launcher"
            + Character.toUpperCase(theme.charAt(0)) + theme.substring(1)
            + Character.toUpperCase(mode.charAt(0)) + mode.substring(1));
    }

    @PluginMethod
    public synchronized void setIcon(PluginCall call) {
        String key = call.getString("key", "");
        String[] parts = key.split("-", -1);
        if (parts.length != 2 || !THEMES.contains(parts[0]) || !(parts[1].equals("light") || parts[1].equals("dark"))) {
            call.reject("Unknown app icon theme");
            return;
        }
        try {
            PackageManager manager = getContext().getPackageManager();
            ComponentName selected = component(parts[0], parts[1]);
            List<ComponentName> disable = new ArrayList<>();
            for (String theme : THEMES) {
                for (String mode : Arrays.asList("light", "dark")) {
                    ComponentName name = component(theme, mode);
                    int state = manager.getComponentEnabledSetting(name);
                    boolean enabled = state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                        || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && theme.equals("ink") && mode.equals("light"));
                    if (enabled && !name.equals(selected)) disable.add(name);
                }
            }
            int selectedState = manager.getComponentEnabledSetting(selected);
            boolean needsEnable = selectedState != PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                && !(selectedState == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && key.equals("ink-light"));
            if (Build.VERSION.SDK_INT >= 33) {
                // Atomic changes avoid transient duplicate/missing icons on newer launchers.
                List<PackageManager.ComponentEnabledSetting> changes = new ArrayList<>();
                if (needsEnable) changes.add(new PackageManager.ComponentEnabledSetting(selected,
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP));
                for (ComponentName name : disable) changes.add(new PackageManager.ComponentEnabledSetting(name,
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP));
                if (!changes.isEmpty()) manager.setComponentEnabledSettings(changes);
            } else {
                // Enable the replacement first, so the app never loses all launcher entries.
                if (needsEnable) manager.setComponentEnabledSetting(selected,
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
                for (ComponentName name : disable) manager.setComponentEnabledSetting(name,
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
            }
            JSObject result = new JSObject();
            result.put("applied", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to update launcher icon", error);
        }
    }
}
