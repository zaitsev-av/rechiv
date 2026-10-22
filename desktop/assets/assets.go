// Иконка встроена: трей запускается до поиска ресурсов бандла и без неё не появится.
package assets

import _ "embed"

//go:generate go run generate_menubar.go

//go:embed menubar.png
var MenuBarIcon []byte

//go:embed menubar-recording.png
var MenuBarRecordingIcon []byte

//go:embed menubar-processing.png
var MenuBarProcessingIcon []byte

//go:embed menubar-stopping.png
var MenuBarStoppingIcon []byte

//go:embed indicator-red.png
var IndicatorRed []byte

//go:embed indicator-blue.png
var IndicatorBlue []byte

//go:embed indicator-green.png
var IndicatorGreen []byte

//go:embed indicator-orange.png
var IndicatorOrange []byte

//go:embed indicator-gray.png
var IndicatorGray []byte
