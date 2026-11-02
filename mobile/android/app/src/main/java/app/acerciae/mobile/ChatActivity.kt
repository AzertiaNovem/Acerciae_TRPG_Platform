package app.acerciae.mobile
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*
data class ChatNotice(val id:String,val title:String,val messages:List<Message>)
@Composable fun ChatActivityBanners(state:AppState,model:AppViewModel,open:()->Unit) {
    Column(Modifier.fillMaxWidth().padding(12.dp),horizontalAlignment=Alignment.End,verticalArrangement=Arrangement.spacedBy(8.dp)) {
        state.chatNotices.take(4).forEach { n -> key(n.id) {
            var expanded by remember { mutableStateOf(false) }
            LaunchedEffect(n.messages.firstOrNull()?.id,expanded) { if(!expanded) { delay(6000); model.dismissNotice(n.id) } }
            Card(Modifier.widthIn(max=320.dp)) { Column(Modifier.padding(12.dp)) {
                Row(verticalAlignment=Alignment.CenterVertically) { TextButton(onClick={expanded=!expanded},modifier=Modifier.weight(1f)) { Text(n.title+if(n.messages.size>1) " · ${n.messages.size}" else "") }; TextButton(onClick={model.dismissNotice(n.id)}) { Text(tr("Close")) } }
                n.messages.take(if(expanded) 6 else 1).forEach { m -> TextButton(onClick={model.launch { model.openEvidence(payload("message_id" to m.id,"chat_window_id" to n.id),false); model.dismissNotice(n.id); open() }}) {
                    ProfileAvatar(WindowActivity.speaker(m),state,model,if(m.kind=="ooc") "" else m.characterAvatarAssetId.orEmpty(),(m.characterAvatarVersion?:0).toString(),m.authorId.orEmpty(),m.authorAvatarVersion?:0,hash=if(m.kind=="ooc") "" else m.characterAvatarHash.orEmpty(),ownerHash=m.authorAvatarHash.orEmpty())
                    Column(Modifier.padding(start=8.dp).weight(1f)) { Text(WindowActivity.speaker(m),style=MaterialTheme.typography.labelMedium); Text(m.displayText,maxLines=2,style=MaterialTheme.typography.bodySmall) }
                } }
            } }
        } }
    }
}
@Composable fun InitiativePanel(state:AppState,model:AppViewModel) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.padding(12.dp)) {
        TextButton(onClick={expanded=!expanded}) { Text(tr("Initiative")+" · "+tr("Round")+" ${state.initiative.number("round")}") }
        if(expanded) {
            state.initiative.rows("entries").forEachIndexed { index,e -> Row(verticalAlignment=Alignment.CenterVertically) {
                Text((if(e.id==state.initiative.text("turn")) "› " else "")+e.name,Modifier.weight(1f)); Text(e.number("total").toString())
                if(state.gm || e.text("created_by")==state.user?.id) TextButton(onClick={model.initiativeAction("remove",e.id)}) { Text(tr("Remove")) }
            } }
            if(state.gm) Row { TextButton(onClick={model.initiativeAction("next")}) { Text(tr("Next turn")) }; TextButton(onClick={model.initiativeAction("clear")}) { Text(tr("Clear")) } }
        }
    }
}
