## launcher_sync.rpy — launcher integration (achievements & play-time sync).
##
## Drop this file into the game's `game/` folder. It needs no other changes.
##
## Whenever an achievement is granted (and at start-up, after loading a save,
## and on quit) it writes a small JSON file next to the save files:
##
##     Windows: %APPDATA%\RenPy\<config.save_directory>\launcher_achievements.json
##     macOS:   ~/Library/RenPy/<config.save_directory>/launcher_achievements.json
##     Linux:   ~/.renpy/<config.save_directory>/launcher_achievements.json
##
## The launcher reads that file to show "x / 60" and the achievement grid.
## Nothing is sent anywhere; it's a local file only.

init 999 python:
    import json
    import os
    import time

    def _launcher_achievement_names():
        names = []
        i = 1
        while hasattr(store, "ach%d" % i):
            names.append(getattr(store, "ach%d" % i))
            i += 1
        return names

    def launcher_write_achievements(*args, **kwargs):
        try:
            names = _launcher_achievement_names()
            unlocked = [n for n in names if achievement.has(n)]
            data = {
                "game": "defending-lydia-collier",
                "version": config.version,
                "total": len(names),
                "unlocked": unlocked,
                "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }
            path = os.path.join(renpy.config.savedir, "launcher_achievements.json")
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            # Atomic replace so the launcher never reads a half-written file.
            try:
                os.replace(tmp, path)
            except AttributeError:
                if os.path.exists(path):
                    os.remove(path)
                os.rename(tmp, path)
        except Exception:
            # Never let launcher bookkeeping affect the game.
            pass

    # Wrap achievement.grant so every existing `$ achievement.grant("…")`
    # call in the scripts also refreshes the file.
    if not getattr(achievement, "_launcher_wrapped", False):
        _launcher_orig_grant = achievement.grant

        def _launcher_grant(name, *args, **kwargs):
            result = _launcher_orig_grant(name, *args, **kwargs)
            launcher_write_achievements()
            return result

        achievement.grant = _launcher_grant
        achievement._launcher_wrapped = True

    config.start_callbacks.append(launcher_write_achievements)
    config.after_load_callbacks.append(launcher_write_achievements)
    config.quit_callbacks.append(launcher_write_achievements)

    # Also write once right now (main menu), so a player who just installs
    # the update and quits still gets their existing achievements synced.
    launcher_write_achievements()
