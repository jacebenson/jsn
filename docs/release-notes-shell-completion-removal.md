# Shell tab-completion removed

JSN no longer provides `jsn completion` or the hidden shell generation interface.
Users may remove previously installed JSN completion snippets from shell startup
files and completion directories. Old snippets invoking the generator no longer
work. Use `jsn --help`, `jsn <command> --help`, or `jsn discover --json` instead.
Command aliases and interactive record pickers are unchanged.
