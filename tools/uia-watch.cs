// Watches the Claude desktop app through Windows UI Automation, like tools/uia-watch.ps1, but as a small native
// helper: a fraction of PowerShell's memory and CPU. Compiled on first run by uia.js with the csc.exe that ships
// with Windows. Prints a line only when the state changes: thinking | waiting | idle | none.
//   uia-watch.exe [-ExtraStop words] [-ExtraAllow words] [-Dump]
using System;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

static class UiaWatch {
  static string Arg(string[] args, string name) {
    int i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : "";
  }

  // Whole button names only: a chat title like "Stop the server" must not count as a Stop button.
  static Regex Names(string[] names, string tail, string extra) {
    string re = "^(" + string.Join("|", names.Select(Regex.Escape)) + ")" + tail;
    if (extra != "") re = "(" + re + ")|^(" + extra + ")";
    return new Regex(re);
  }

  // Only the app has a main window: the console claude.exe from Claude Code has none.
  static bool IsApp(Process p) {
    try { return p.MainWindowHandle != IntPtr.Zero; } catch { return false; }
  }

  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    bool dump = args.Contains("-Dump");
    var stopRe = Names(new[] { "Stop", "Stop response", "Stop generating", "Остановить", "Остановить ответ" }, "$", Arg(args, "-ExtraStop"));
    var allowRe = Names(new[] { "Allow", "Approve", "Разрешить" }, @"(\s.{0,24})?$", Arg(args, "-ExtraAllow"));
    var buttons = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
    var cache = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.None };
    cache.Add(AutomationElement.NameProperty);

    string last = "";
    while (true) {
      string state = "none";
      bool dumped = false;
      foreach (var p in Process.GetProcessesByName("Claude")) {
        using (p) {
          if (!IsApp(p)) continue;
          try {
            // The root needs a live reference, so it is taken before the names-only cache is switched on.
            var root = AutomationElement.FromHandle(p.MainWindowHandle);
            AutomationElementCollection all;
            using (cache.Activate()) all = root.FindAll(TreeScope.Descendants, buttons);
            bool busy = false, ask = false;
            foreach (AutomationElement e in all) {
              string n = e.Cached.Name;
              if (string.IsNullOrEmpty(n)) continue;
              if (dump) { Console.WriteLine(n); dumped = true; continue; }
              if (stopRe.IsMatch(n)) busy = true;
              if (allowRe.IsMatch(n)) ask = true;
            }
            if (ask) state = "waiting";
            else if (busy && state != "waiting") state = "thinking";
            else if (state == "none") state = "idle";
          } catch { if (state == "none") state = "idle"; }
        }
      }
      if (dump) { if (!dumped) Console.WriteLine("__no_window__"); return 0; }
      if (state != last) { Console.WriteLine(state); Console.Out.Flush(); last = state; }
      Thread.Sleep(state == "none" ? 2000 : 700);   // Claude closed: nothing to read, check less often
    }
  }
}
