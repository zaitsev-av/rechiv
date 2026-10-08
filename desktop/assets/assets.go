// Иконка встроена: трей запускается до поиска ресурсов бандла и без неё не появится.
package assets

import _ "embed"

//go:embed menubar.png
var MenuBarIcon []byte
